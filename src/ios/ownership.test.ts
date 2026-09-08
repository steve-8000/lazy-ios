/**
 * Ownership invariants.
 *
 * These are the rules whose violation destroys someone's work: this machine
 * carries long-lived user simulators (folio-*, JustSend_01) alongside lazy-ios
 * scratch devices, and a reaper that guesses wrong deletes the wrong one.
 *
 * Every case exercises a decision made *before* any destructive `simctl` call,
 * against UDIDs that do not exist, so the suite never touches a real device.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The ledger resolves its paths once, at module evaluation, so the home has to
// exist in the environment before the module is loaded. Static `import`
// statements are hoisted above this assignment, hence the dynamic import — the
// one case where a literal specifier still needs `await import`.
const home = mkdtempSync(join(tmpdir(), "lazy-ios-test-"));
process.env.LAZY_IOS_HOME = home;

const { LedgerCorrupt, overdue, readLedger, reclaimable, withLedger } = await import("../core/ledger.ts");
const { reapSimulators, releaseSimulator } = await import("./simulator.ts");

afterAll(() => {
	rmSync(home, { recursive: true, force: true });
	delete process.env.LAZY_IOS_HOME;
});

/**
 * pid 1 is launchd: always alive, never ours, and `kill(1, 0)` answers EPERM
 * rather than ESRCH — exactly the "alive but another user's" case `isAlive`
 * has to get right.
 */
const LIVE_FOREIGN_PID = 1;
/** Above the pid ceiling, so it can never collide with a real process. */
const DEAD_PID = 0x7fff_fffe;

/**
 * Seed one lease under a key unique to the calling test.
 *
 * No shared reset between tests: every case owns its own UDID, so the cases
 * are independent by construction rather than by teardown ordering.
 */
async function seedLease(udid: string, overrides: Record<string, unknown> = {}): Promise<void> {
	await withLedger((state) => {
		state.devices[udid] = {
			udid,
			name: "scratch",
			runtime: "iOS 27.0",
			provenance: "created",
			acquiredAt: Date.now() - 3_600_000,
			// Deliberately long expired: expiry must not authorise anything.
			expiresAt: Date.now() - 1_800_000,
			holderPid: LIVE_FOREIGN_PID,
			purpose: "test",
			wasBooted: false,
			...overrides,
		};
	});
}

test("an expired lease held by a live process is not reclaimable", async () => {
	const udid = "UDID-live-holder";
	await seedLease(udid);

	const state = await readLedger();
	expect(reclaimable(state).map((lease) => lease.udid)).not.toContain(udid);
	// Surfaced for a human, never acted on.
	expect(overdue(state).map((lease) => lease.udid)).toContain(udid);
});

test("an expired lease whose holder died is reclaimable", async () => {
	const udid = "UDID-dead-holder";
	await seedLease(udid, { holderPid: DEAD_PID });

	expect(reclaimable(await readLedger()).map((lease) => lease.udid)).toContain(udid);
});

test("releasing a device held by another live process is refused", async () => {
	const udid = "UDID-refuse-release";
	await seedLease(udid, {});

	await expect(releaseSimulator(udid, { destroy: true })).rejects.toThrow(/held by live pid 1/);
	// The lease survives the refusal: the real holder still owns it.
	expect((await readLedger()).devices[udid]?.holderPid).toBe(LIVE_FOREIGN_PID);
});

test("a scratch device whose holder is gone is deleted and forgotten", async () => {
	const udid = "UDID-scratch-reclaim";
	await seedLease(udid, { holderPid: DEAD_PID });

	const outcome = await releaseSimulator(udid, { destroy: true });
	expect(outcome.action).toBe("deleted");
	expect((await readLedger()).devices[udid]).toBeUndefined();
});

test("an adopted device already booted is left running and never deleted", async () => {
	const udid = "UDID-adopted-running";
	await seedLease(udid, { provenance: "adopted", holderPid: 0, wasBooted: true });

	const outcome = await releaseSimulator(udid, { destroy: true });
	expect(outcome.action).toBe("left-running");
	expect((await readLedger()).devices[udid]).toBeUndefined();
});

test("an adopted device booted by lazy-ios is only shut down", async () => {
	const udid = "UDID-adopted-booted-by-us";
	await seedLease(udid, { provenance: "adopted", holderPid: 0, wasBooted: false });

	const outcome = await releaseSimulator(udid, { destroy: true });
	expect(outcome.action).toBe("shutdown");
});

test("a device with no lease is left untouched", async () => {
	const outcome = await releaseSimulator("UDID-never-leased", { destroy: true });

	expect(outcome.action).toBe("not-leased");
});

test("a corrupt ledger fails closed instead of reading as empty", async () => {
	const udid = "UDID-corrupt-guard";
	await seedLease(udid, { holderPid: DEAD_PID });
	const ledgerFile = join(home, "ledger.json");
	const good = await readFile(ledgerFile, "utf8");

	await writeFile(ledgerFile, "{ this is not json", "utf8");
	try {
		// Reading it as "{}" would tell the reaper that every lazy-ios device is
		// unowned — the shortest path to deleting something we cannot prove is
		// ours. Refusing is the only safe answer.
		await expect(readLedger()).rejects.toThrow(LedgerCorrupt);
		await expect(reapSimulators({ destroyScratch: true })).rejects.toThrow(/unreadable/);
	} finally {
		await writeFile(ledgerFile, good, "utf8");
	}

	// And the lease is intact once the file is readable again.
	expect((await readLedger()).devices[udid]).toBeDefined();
});

test("separate processes writing the ledger do not lose updates", async () => {
	// The in-process queue cannot be what makes this pass — these are real OS
	// processes, so only the `flock` on the lock fd serialises them. Every
	// path-based lock tried before this (`open(…,"wx")`, `link()` + stale
	// breaking) could admit two writers when a holder died, and last-writer-
	// wins silently dropped a claim.
	const writer = join(home, "writer.ts");
	await writeFile(
		writer,
		`const { withLedger } = await import(${JSON.stringify(join(import.meta.dir, "../core/ledger.ts"))});
		const key = process.argv[2];
		await withLedger((state) => {
			// Hold the critical section open long enough that unserialised
			// writers would certainly interleave.
			const until = Date.now() + 40;
			while (Date.now() < until);
			state.processes[key] = { key, pid: 1, startedAt: Date.now(), argv: ["x"] };
		});`,
		"utf8",
	);

	const keys = Array.from({ length: 6 }, (_, index) => `proc-${index}`);
	const codes = await Promise.all(
		keys.map(async (key) => {
			const child = Bun.spawn(["bun", writer, key], {
				env: { ...process.env, LAZY_IOS_HOME: home },
				stdout: "pipe",
				stderr: "pipe",
			});
			return await child.exited;
		}),
	);
	expect(codes).toEqual(keys.map(() => 0));

	const recorded = Object.keys((await readLedger()).processes);
	expect(keys.filter((key) => recorded.includes(key))).toEqual(keys);
});

test("a killed lock holder does not block the next writer", async () => {
	// The reason the lock is flock(2) and not a lock file. Every path-based
	// scheme needed a stale-detection heuristic to recover from this, and each
	// heuristic had a race that let two writers in. Here the kernel releases
	// the lock when the holder dies, so the next writer just proceeds.
	const holder = join(home, "holder.ts");
	await writeFile(
		holder,
		`const { withLedger } = await import(${JSON.stringify(join(import.meta.dir, "../core/ledger.ts"))});
		await withLedger(() => {
			console.log("locked");
			// Never returns; the parent SIGKILLs this process while it holds
			// the lock, simulating a crash mid-mutation.
			Bun.sleepSync(60_000);
		});`,
		"utf8",
	);

	const child = Bun.spawn(["bun", holder], {
		env: { ...process.env, LAZY_IOS_HOME: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	// Wait for it to actually hold the lock before killing it.
	const reader = child.stdout.getReader();
	const first = await reader.read();
	expect(new TextDecoder().decode(first.value)).toContain("locked");
	child.kill("SIGKILL");
	await child.exited;

	const started = Date.now();
	await withLedger((state) => {
		state.processes["after-crash"] = { key: "after-crash", pid: DEAD_PID, startedAt: Date.now(), argv: ["x"] };
	});
	// No stale timeout to wait out: the kernel already released it.
	expect(Date.now() - started).toBeLessThan(2_000);
	expect((await readLedger()).processes["after-crash"]).toBeDefined();
});

test("concurrent ledger writers do not lose updates", async () => {
	// A lost update here is a device that exists but is recorded nowhere —
	// the original leak. This caught a real race: the lock file was visible
	// before its pid was written, so waiters judged it corrupt and broke it.
	const keys = Array.from({ length: 8 }, (_, index) => `writer-${index}`);
	await Promise.all(
		keys.map((key, index) =>
			withLedger((state) => {
				state.processes[key] = {
					key,
					pid: DEAD_PID - index,
					startedAt: Date.now(),
					argv: ["test"],
				};
			}),
		),
	);

	const recorded = Object.keys((await readLedger()).processes);
	expect(keys.filter((key) => recorded.includes(key))).toEqual(keys);
});
