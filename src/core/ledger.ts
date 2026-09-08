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
import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
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
	argv: readonly string[];
}

export interface LedgerState {
	version: number;
	devices: Record<string, DeviceLease>;
	processes: Record<string, ProcessRecord>;
}

const EMPTY: LedgerState = { version: LEDGER_VERSION, devices: {}, processes: {} };

function ensureHome(): void {
	mkdirSync(LAZY_HOME, { recursive: true });
}

async function acquireLock(): Promise<() => Promise<void>> {
	ensureHome();
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			const handle = await open(LOCK_PATH, "wx");
			await handle.writeFile(String(process.pid));
			await handle.close();
			return async () => {
				await rm(LOCK_PATH, { force: true });
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			// Break a lock whose holder is gone, or one that is simply too old.
			let stale = false;
			try {
				const raw = await readFile(LOCK_PATH, "utf8");
				const holder = Number.parseInt(raw.trim(), 10);
				stale = !Number.isFinite(holder) || !isAlive(holder);
				if (!stale) {
					const info = await Bun.file(LOCK_PATH).stat();
					stale = Date.now() - info.mtimeMs > LOCK_STALE_MS;
				}
			} catch {
				stale = true;
			}
			if (stale) {
				await rm(LOCK_PATH, { force: true });
				continue;
			}
			if (Date.now() >= deadline) throw new Error(`ledger lock held for >${LOCK_WAIT_MS}ms at ${LOCK_PATH}`);
			await Bun.sleep(50);
		}
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

export async function readLedger(): Promise<LedgerState> {
	try {
		const raw = await readFile(LEDGER_PATH, "utf8");
		const parsed = JSON.parse(raw) as Partial<LedgerState>;
		if (parsed.version !== LEDGER_VERSION) return { ...EMPTY };
		return {
			version: LEDGER_VERSION,
			devices: parsed.devices ?? {},
			processes: parsed.processes ?? {},
		};
	} catch {
		return { ...EMPTY };
	}
}

/**
 * Read-modify-write the ledger under the advisory lock.
 * `mutate` must be pure with respect to the outside world: it may run twice
 * only if the caller retries, and it holds a cross-process lock while running,
 * so it must not await long operations.
 */
export async function withLedger<T>(mutate: (state: LedgerState) => T | Promise<T>): Promise<T> {
	const release = await acquireLock();
	try {
		const state = await readLedger();
		const value = await mutate(state);
		const tmp = `${LEDGER_PATH}.${process.pid}.tmp`;
		await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		await rename(tmp, LEDGER_PATH);
		return value;
	} finally {
		await release();
	}
}

export const ledgerPath = LEDGER_PATH;

/**
 * Leases that no live process is holding, or whose deadline passed.
 * Only these are candidates for reclamation — never anything else.
 */
export function reclaimable(state: LedgerState, now = Date.now()): DeviceLease[] {
	return Object.values(state.devices).filter(
		(lease) => lease.expiresAt <= now || lease.holderPid === 0 || !isAlive(lease.holderPid),
	);
}
