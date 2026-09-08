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

import { mkdirSync } from "node:fs";
import { link, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const LAZY_HOME = process.env.LAZY_IOS_HOME ?? join(homedir(), ".lazy-ios");
const LEDGER_PATH = join(LAZY_HOME, "ledger.json");
const LOCK_PATH = join(LAZY_HOME, "ledger.lock");
/** A lock older than this belonged to a process that died holding it. */
const LOCK_STALE_MS = 30_000;
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
 * Cross-process advisory lock.
 *
 * Uses `link()` rather than `open(…, "wx")`: with `wx` the file exists for a
 * moment before its pid is written, and a waiter that reads it in that window
 * sees empty content. Treating empty as "corrupt, therefore stale" made two
 * processes hold the lock at once — measured, not theoretical. `link` publishes
 * a file that already has its contents.
 */
async function acquireLock(): Promise<() => Promise<void>> {
	ensureHome();
	const deadline = Date.now() + LOCK_WAIT_MS;
	const staging = `${LOCK_PATH}.${process.pid}.${Bun.randomUUIDv7().slice(0, 8)}`;
	await writeFile(staging, `${process.pid}\n`, "utf8");
	try {
		for (;;) {
			try {
				await link(staging, LOCK_PATH);
				return async () => {
					await rm(LOCK_PATH, { force: true });
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if (await lockIsStale()) {
					await rm(LOCK_PATH, { force: true });
					continue;
				}
				if (Date.now() >= deadline) throw new Error(`ledger lock held for >${LOCK_WAIT_MS}ms at ${LOCK_PATH}`);
				await Bun.sleep(25);
			}
		}
	} finally {
		await rm(staging, { force: true });
	}
}

/** A lock whose holder died, or that is old enough to be abandoned. */
async function lockIsStale(): Promise<boolean> {
	try {
		const raw = await readFile(LOCK_PATH, "utf8");
		const holder = Number.parseInt(raw.trim(), 10);
		// A live holder keeps the lock however long its mutation takes. Breaking
		// on age alone would let a slow writer be overtaken and lose its update,
		// which is the failure the lock exists to prevent.
		if (Number.isFinite(holder)) return !isAlive(holder);
		// Only an empty or unparseable lock falls back to age — that shape can
		// only come from a process that died mid-write.
		const info = await Bun.file(LOCK_PATH).stat();
		return Date.now() - info.mtimeMs > LOCK_STALE_MS;
	} catch (error) {
		// Vanished between the failed link and this read: not stale, just gone.
		// Retrying the link is correct and cheap.
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}

/**
 * Serialises `withLedger` inside this process.
 *
 * The file lock alone is not enough: two concurrent calls in one process share
 * a pid, so each would consider the other's lock its own to break, and both
 * would write the same temp file. A promise chain makes in-process contention
 * ordered and free.
 */
let ledgerQueue: Promise<unknown> = Promise.resolve();

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

export async function readLedger(): Promise<LedgerState> {
	try {
		const raw = await readFile(LEDGER_PATH, "utf8");
		const parsed = JSON.parse(raw) as Partial<LedgerState>;
		if (parsed.version !== LEDGER_VERSION) return emptyState();
		return {
			version: LEDGER_VERSION,
			devices: parsed.devices ?? {},
			processes: parsed.processes ?? {},
		};
	} catch {
		return emptyState();
	}
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
			const tmp = `${LEDGER_PATH}.${process.pid}.${Bun.randomUUIDv7().slice(0, 8)}.tmp`;
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
