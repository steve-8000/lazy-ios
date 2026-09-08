/**
 * Ownership ledger.
 *
 * The single defence against the two leaks this project exists to fix:
 * simulators that are created and never reclaimed, and helper processes
 * (Appium servers) that accumulate one per client session.
 *
 * The rule the whole codebase is built on:
 *
 *   lazy-ios may shut down or delete ONLY a device it created itself and
 *   recorded here. A device that already existed when we found it is
 *   *adopted*: usable, never destroyed, never even shut down.
 *
 * That distinction is why this file exists instead of a `simctl delete
 * unavailable`-style sweep. The machine this runs on has long-lived user
 * simulators (folio-*, JustSend_01, …) that a naive reaper would destroy.
 *
 * On-disk format is a single JSON document rewritten atomically under an
 * advisory lock, so several MCP instances in different editors cannot
 * interleave a read-modify-write.
 */

import { dlopen, FFIType } from "bun:ffi";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const LAZY_HOME = process.env.LAZY_IOS_HOME ?? join(homedir(), ".lazy-ios");
const LEDGER_PATH = join(LAZY_HOME, "ledger.json");
const LOCK_PATH = join(LAZY_HOME, "ledger.lock");
const LOCK_WAIT_MS = 10_000;

export const LEDGER_VERSION = 2;

/** How a device came under our control. Governs what teardown may do. */
export type Provenance =
	/** lazy-ios ran `simctl create`. We may shut it down and delete it. */
	| "created"
	/** The device already existed. We may boot and drive it, never destroy it. */
	| "adopted";

export interface DeviceLease {
	udid: string;
	name: string;
	runtime: string;
	provenance: Provenance;
	/** Epoch ms when the lease was taken. */
	acquiredAt: number;
	/** Epoch ms after which a reaper may reclaim this lease. */
	expiresAt: number;
	/** PID of the lazy-ios instance holding the lease; 0 once released. */
	holderPid: number;
	/** Free-text tag so a human reading the ledger knows what took it. */
	purpose: string;
	/** True when the device was already booted before we touched it. */
	wasBooted: boolean;
}

export interface ProcessRecord {
	/** Stable logical name, e.g. "appium". One live record per key. */
	key: string;
	pid: number;
	port?: number;
	startedAt: number;
	/**
	 * `ps -o lstart=` for this pid, captured at spawn. macOS reuses pids, so
	 * this string is the identity check performed before any signal is sent.
	 */
	lstart?: string;
	argv: readonly string[];
}

export interface LedgerState {
	version: number;
	devices: Record<string, DeviceLease>;
	processes: Record<string, ProcessRecord>;
}

/**
 * A fresh empty state.
 *
 * Must be a factory, not a shared constant: callers mutate what `readLedger`
 * returns, and a shallow spread of a constant would share its `devices` and
 * `processes` objects across every reader.
 */
function emptyState(): LedgerState {
	return { version: LEDGER_VERSION, devices: {}, processes: {} };
}

function ensureHome(): void {
	mkdirSync(LAZY_HOME, { recursive: true });
}

/**
 * Cross-process advisory lock, backed by `flock(2)`.
 *
 * Every path-based scheme tried before this one — `open(…,"wx")`, then
 * `link()` with inode-checked release — has the same irreducible flaw: the
 * lock is a *name*, so breaking an abandoned one is a separate, racy
 * operation, and two waiters can both remove it and both proceed. Each fix
 * only relocated the race (a breaker file needs its own breaker).
 *
 * `flock` has no such problem. The lock lives on the open file description,
 * not the path: the kernel releases it when the fd closes or the process dies,
 * so there is nothing to detect as stale and the file is never unlinked. The
 * measured semantics on this machine (darwin, APFS) are that a second `flock`
 * with LOCK_NB fails even from the same process on a different fd.
 */
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

const libc = dlopen("libSystem.B.dylib", {
	flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

let lockFd: number | null = null;

function lockDescriptor(): number {
	if (lockFd === null) {
		ensureHome();
		// "a+" creates on demand and never truncates: the file's contents are
		// irrelevant, only its identity as a lock target.
		lockFd = openSync(LOCK_PATH, "a+");
	}
	return lockFd;
}

async function acquireLock(): Promise<() => Promise<void>> {
	const fd = lockDescriptor();
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) === 0) {
			return async () => {
				libc.symbols.flock(fd, LOCK_UN);
			};
		}
		if (Date.now() >= deadline) {
			throw new Error(`ledger lock held for >${LOCK_WAIT_MS}ms at ${LOCK_PATH}`);
		}
		await Bun.sleep(25);
	}
}

/**
 * Serialises `withLedger` inside this process.
 *
 * Load-bearing, not an optimisation: `flock` is held per open file
 * description, and this process keeps exactly one. A second concurrent
 * `withLedger` on the same fd would have its `flock` succeed immediately —
 * re-locking an fd you already own is a no-op upgrade — and two mutations
 * would interleave. The queue is what makes in-process access exclusive;
 * `flock` handles the cross-process half.
 */
let ledgerQueue: Promise<unknown> = Promise.resolve();

/** Release the lock fd. Used by tests; the kernel does this on exit anyway. */
export function closeLedgerLock(): void {
	if (lockFd !== null) {
		closeSync(lockFd);
		lockFd = null;
	}
}

/** Signal-0 liveness probe. Returns false for pids we cannot see at all. */
export function isAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the pid exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The ledger exists but cannot be interpreted. Never treated as "empty". */
export class LedgerCorrupt extends Error {
	constructor(reason: string) {
		super(
			`${LEDGER_PATH} is unreadable (${reason}). lazy-ios will not reclaim devices while ownership is unknown. ` +
				`Inspect the file; move it aside only once you have confirmed no lazy-ios simulators are still booted.`,
		);
		this.name = "LedgerCorrupt";
	}
}

/**
 * Read the ledger, or fail closed.
 *
 * A missing file is normal — nothing has been leased yet. A file that exists
 * but will not parse is *not* the same thing: answering "empty" there would
 * tell the reaper that every lazy-ios device is unowned, and the very next
 * cleanup would either orphan live devices or delete devices whose provenance
 * we could no longer prove. Refusing is the safe direction.
 */
export async function readLedger(): Promise<LedgerState> {
	let raw: string;
	try {
		raw = await readFile(LEDGER_PATH, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
		throw new LedgerCorrupt((error as Error).message);
	}
	let parsed: Partial<LedgerState>;
	try {
		parsed = JSON.parse(raw) as Partial<LedgerState>;
	} catch (error) {
		throw new LedgerCorrupt(`invalid JSON: ${(error as Error).message}`);
	}
	if (parsed.version !== LEDGER_VERSION) {
		throw new LedgerCorrupt(`schema version ${String(parsed.version)}, expected ${LEDGER_VERSION}`);
	}
	return {
		version: LEDGER_VERSION,
		devices: parsed.devices ?? {},
		processes: parsed.processes ?? {},
	};
}

/**
 * Read-modify-write the ledger under the advisory lock.
 * `mutate` must be pure with respect to the outside world: it may run twice
 * only if the caller retries, and it holds a cross-process lock while running,
 * so it must not await long operations.
 */
export async function withLedger<T>(mutate: (state: LedgerState) => T | Promise<T>): Promise<T> {
	const run = async (): Promise<T> => {
		const release = await acquireLock();
		try {
			const state = await readLedger();
			const value = await mutate(state);
			const tmp = `${LEDGER_PATH}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
			await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
			await rename(tmp, LEDGER_PATH);
			return value;
		} finally {
			await release();
		}
	};
	// Chain onto the queue whether or not the previous call succeeded.
	const queued = ledgerQueue.then(run, run);
	ledgerQueue = queued.catch(() => undefined);
	return await queued;
}

export const ledgerPath = LEDGER_PATH;

/**
 * True when nothing alive is holding this lease.
 *
 * Deliberately ignores `expiresAt`. A deadline is a hint that a run has gone
 * long, not evidence that it is over: reclaiming a device out from under a
 * live holder destroys a session that is still using it — a `keepOpen`
 * session, or a test suite past the half-hour mark. Only a dead or released
 * holder frees a device; expiry is reported, never acted on.
 */
export function unheld(lease: DeviceLease): boolean {
	return lease.holderPid === 0 || !isAlive(lease.holderPid);
}

/**
 * Leases no live process holds. Only these may be reclaimed — never anything
 * else, and never a device whose provenance is not "created".
 */
export function reclaimable(state: LedgerState): DeviceLease[] {
	return Object.values(state.devices).filter(unheld);
}

/** Held leases whose deadline has passed. Reported by the doctor, not reaped. */
export function overdue(state: LedgerState, now = Date.now()): DeviceLease[] {
	return Object.values(state.devices).filter((lease) => !unheld(lease) && lease.expiresAt <= now);
}

/** Push a live lease's deadline out. Called whenever a session is used. */
export async function renewLease(udid: string, ttl: number): Promise<void> {
	await withLedger((state) => {
		const lease = state.devices[udid];
		if (lease && lease.holderPid === process.pid) lease.expiresAt = Date.now() + ttl;
	});
}
