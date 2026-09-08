/**
 * Simulator lifecycle with ownership.
 *
 * Everything here funnels through the ledger so that the destructive verbs
 * (`shutdown`, `delete`) can only ever reach a device this process created.
 * The reuse path matters as much as the reap path: a scratch device that is
 * shut down but kept costs nothing and skips the ~20 s create+first-boot, so
 * repeated runs converge on one device per (runtime, device type) instead of
 * one per invocation.
 */

import { run, runJson, runOk, waitFor } from "../core/exec.ts";
import { type DeviceLease, overdue, reclaimable, unheld, withLedger } from "../core/ledger.ts";

/** Devices we create are named with this prefix. It is a hint, never authority. */
export const SCRATCH_PREFIX = "lazy-ios";
/** Ceiling on simultaneously-leased scratch devices; older ones get reaped first. */
const MAX_SCRATCH_DEVICES = 3;
const DEFAULT_LEASE_MS = 30 * 60_000;

export interface SimDevice {
	udid: string;
	name: string;
	state: string;
	runtime: string;
	/** simctl runtime identifier, e.g. com.apple.CoreSimulator.SimRuntime.iOS-27-0 */
	runtimeId: string;
	deviceTypeId?: string;
	isAvailable: boolean;
}

interface SimctlList {
	devices: Record<string, Array<{
		udid: string;
		name: string;
		state: string;
		isAvailable?: boolean;
		deviceTypeIdentifier?: string;
	}>>;
}

interface SimctlRuntimes {
	runtimes: Array<{ identifier: string; name: string; version: string; isAvailable: boolean; platform?: string }>;
}

interface SimctlDeviceTypes {
	devicetypes: Array<{ identifier: string; name: string; productFamily?: string }>;
}

function runtimeLabel(runtimeId: string): string {
	// com.apple.CoreSimulator.SimRuntime.iOS-27-0 -> iOS 27.0
	const tail = runtimeId.split(".").pop() ?? runtimeId;
	const match = /^([A-Za-z]+)-(.+)$/.exec(tail);
	if (!match) return tail;
	return `${match[1]} ${match[2]!.replaceAll("-", ".")}`;
}

export async function listSimulators(): Promise<SimDevice[]> {
	const listed = await runJson<SimctlList>(["xcrun", "simctl", "list", "devices", "--json"], { timeout: 30_000 });
	const devices: SimDevice[] = [];
	for (const [runtimeId, entries] of Object.entries(listed.devices)) {
		for (const entry of entries) {
			devices.push({
				udid: entry.udid,
				name: entry.name,
				state: entry.state,
				runtimeId,
				runtime: runtimeLabel(runtimeId),
				deviceTypeId: entry.deviceTypeIdentifier,
				isAvailable: entry.isAvailable !== false,
			});
		}
	}
	return devices;
}

export async function findSimulator(udid: string): Promise<SimDevice | null> {
	const all = await listSimulators();
	return all.find((device) => device.udid === udid) ?? null;
}

/** Newest available iOS runtime, or the one whose version/name matches `hint`. */
export async function resolveRuntime(hint?: string): Promise<{ identifier: string; name: string; version: string }> {
	const { runtimes } = await runJson<SimctlRuntimes>(["xcrun", "simctl", "list", "runtimes", "--json"], {
		timeout: 30_000,
	});
	const ios = runtimes.filter(
		(runtime) => runtime.isAvailable && (runtime.platform === "iOS" || runtime.identifier.includes("SimRuntime.iOS")),
	);
	if (ios.length === 0) throw new Error("no available iOS simulator runtime — install one via Xcode > Settings > Components");
	if (hint) {
		const needle = hint.toLowerCase();
		const hit = ios.find(
			(runtime) =>
				runtime.version === hint ||
				runtime.identifier.toLowerCase() === needle ||
				runtime.name.toLowerCase().includes(needle),
		);
		if (!hit) throw new Error(`no iOS runtime matching "${hint}" (have: ${ios.map((r) => r.version).join(", ")})`);
		return hit;
	}
	// Highest version wins; simctl does not guarantee list order.
	const rank = (version: string): number => {
		const [major = "0", minor = "0"] = version.split(".");
		return Number.parseInt(major, 10) * 1000 + Number.parseInt(minor, 10);
	};
	return ios.reduce((best, runtime) => (rank(runtime.version) > rank(best.version) ? runtime : best));
}

export async function resolveDeviceType(hint?: string): Promise<{ identifier: string; name: string }> {
	const { devicetypes } = await runJson<SimctlDeviceTypes>(["xcrun", "simctl", "list", "devicetypes", "--json"], {
		timeout: 30_000,
	});
	const phones = devicetypes.filter((type) => type.identifier.includes("iPhone"));
	if (hint) {
		const needle = hint.toLowerCase();
		const hit =
			devicetypes.find((type) => type.identifier.toLowerCase() === needle) ??
			devicetypes.find((type) => type.name.toLowerCase() === needle) ??
			devicetypes.find((type) => type.name.toLowerCase().includes(needle));
		if (!hit) throw new Error(`no simulator device type matching "${hint}"`);
		return hit;
	}
	// simctl lists device types in registration order, not model order, so
	// `.at(-1)` picked an iPhone 11 Pro on this machine. Rank by model number.
	const generation = (identifier: string): number => Number.parseInt(/iPhone-(\d+)/.exec(identifier)?.[1] ?? "0", 10);
	const pros = phones.filter((type) => /iPhone-\d+-Pro$/.test(type.identifier));
	const pool = pros.length > 0 ? pros : phones;
	const best = pool.reduce<{ identifier: string; name: string } | null>(
		(winner, type) => (winner && generation(winner.identifier) >= generation(type.identifier) ? winner : type),
		null,
	);
	if (!best) throw new Error("no iPhone simulator device types installed");
	return best;
}

export async function boot(udid: string, timeout = 180_000): Promise<void> {
	const booted = await run(["xcrun", "simctl", "boot", udid], { timeout: 60_000 });
	// "Unable to boot device in current state: Booted" is success for our purposes.
	if (booted.code !== 0 && !/current state: Booted/i.test(booted.stderr)) {
		throw new Error(`simctl boot ${udid} failed: ${booted.stderr.trim() || booted.stdout.trim()}`);
	}
	await runOk(["xcrun", "simctl", "bootstatus", udid, "-b"], { timeout });
}

export async function shutdown(udid: string): Promise<void> {
	const result = await run(["xcrun", "simctl", "shutdown", udid], { timeout: 60_000 });
	if (result.code !== 0 && !/current state: Shutdown|Invalid device/i.test(result.stderr)) {
		throw new Error(`simctl shutdown ${udid} failed: ${result.stderr.trim()}`);
	}
}

export interface AcquireOptions {
	/** Drive this exact device. It is adopted: never deleted, never destroyed. */
	udid?: string;
	/** iOS version or runtime identifier. Default: newest installed. */
	runtime?: string;
	/** Device type name or identifier. Default: newest iPhone Pro. */
	deviceType?: string;
	purpose: string;
	/** Lease duration in ms. Default 30 min. */
	ttl?: number;
	/** Create a fresh device even when an idle scratch device matches. */
	fresh?: boolean;
}

export interface AcquiredSimulator {
	lease: DeviceLease;
	device: SimDevice;
	/** How the device was obtained, for the caller's report. */
	disposition: "adopted" | "reused" | "created";
}

/**
 * Take a simulator under lease, creating one only when no idle scratch device
 * already matches. Boots it and waits for `bootstatus`.
 */
export async function acquireSimulator(options: AcquireOptions): Promise<AcquiredSimulator> {
	const ttl = options.ttl ?? DEFAULT_LEASE_MS;

	if (options.udid) {
		const device = await findSimulator(options.udid);
		if (!device) throw new Error(`simulator ${options.udid} not found`);
		const wasBooted = device.state === "Booted";
		const lease = await claim(device, "adopted", options.purpose, ttl, wasBooted);
		await bootOrUnclaim(device.udid, wasBooted);
		return { lease, device: (await findSimulator(device.udid)) ?? device, disposition: "adopted" };
	}

	const runtime = await resolveRuntime(options.runtime);
	const deviceType = await resolveDeviceType(options.deviceType);

	if (!options.fresh) {
		const reusable = await findIdleScratch(runtime.identifier, deviceType.identifier);
		if (reusable) {
			const wasBooted = reusable.state === "Booted";
			const lease = await claim(reusable, "created", options.purpose, ttl, wasBooted);
			await bootOrUnclaim(reusable.udid, wasBooted);
			return { lease, device: (await findSimulator(reusable.udid)) ?? reusable, disposition: "reused" };
		}
	}

	await enforceScratchCeiling();

	const name = `${SCRATCH_PREFIX}-${deviceType.name.replaceAll(/\s+/g, "")}-${Bun.randomUUIDv7().slice(0, 8)}`;
	const created = await runOk(["xcrun", "simctl", "create", name, deviceType.identifier, runtime.identifier], {
		timeout: 120_000,
	});
	const udid = created.stdout.trim();
	const device = (await findSimulator(udid)) ?? {
		udid,
		name,
		state: "Shutdown",
		runtime: runtimeLabel(runtime.identifier),
		runtimeId: runtime.identifier,
		deviceTypeId: deviceType.identifier,
		isAvailable: true,
	};
	// Rollback matters here: a device that exists but was never recorded is an
	// orphan by construction — reaping only ever considers ledger entries, so
	// nothing would clean it up. `claim` can fail on ledger lock contention.
	let lease: DeviceLease;
	try {
		lease = await claim(device, "created", options.purpose, ttl, false);
	} catch (error) {
		await run(["xcrun", "simctl", "delete", udid], { timeout: 120_000 });
		throw new Error(`created ${udid} but could not record it (rolled back with simctl delete): ${(error as Error).message}`);
	}
	await bootOrUnclaim(udid, false);
	return { lease, device: (await findSimulator(udid)) ?? device, disposition: "created" };
}

/**
 * Boot a device we have just claimed, undoing the claim if the boot fails.
 *
 * Without this, a `bootstatus` timeout leaves a lease held by a live pid whose
 * caller never received an `AcquiredSimulator` and therefore has nothing to
 * release: the ledger reaper would keep skipping it for as long as this
 * process lives. `wasBooted` devices are left alone — we did not start them.
 */
async function bootOrUnclaim(udid: string, wasBooted: boolean): Promise<void> {
	if (wasBooted) return;
	try {
		await boot(udid);
	} catch (error) {
		await shutdown(udid).catch(() => undefined);
		await withLedger((state) => {
			const entry = state.devices[udid];
			// Keep the record (it remembers we created the device) but stop
			// claiming it, so the next reap can reclaim or delete it.
			if (entry) {
				entry.holderPid = 0;
				entry.expiresAt = Date.now();
			}
		});
		claimedHere.delete(udid);
		throw error;
	}
}

async function claim(
	device: SimDevice,
	provenance: DeviceLease["provenance"],
	purpose: string,
	ttl: number,
	wasBooted: boolean,
): Promise<DeviceLease> {
	const now = Date.now();
	// A lease this process already holds is not free just because we are the
	// holder: another open session is using that device.
	if (claimedHere.has(device.udid)) {
		throw new Error(`simulator ${device.udid} is already leased by an open session in this process`);
	}
	const lease = await withLedger((state) => {
		const existing = state.devices[device.udid];
		// Expiry is not release. A live holder keeps the device however long
		// its run has taken.
		if (existing && existing.holderPid !== process.pid && !unheld(existing)) {
			throw new Error(
				`simulator ${device.udid} is leased by live pid ${existing.holderPid} (lease until ${new Date(existing.expiresAt).toISOString()})`,
			);
		}
		const lease: DeviceLease = {
			udid: device.udid,
			name: device.name,
			runtime: device.runtime,
			// A device we created stays "created" forever, even across re-leases.
			provenance: existing?.provenance === "created" ? "created" : provenance,
			acquiredAt: now,
			expiresAt: now + ttl,
			holderPid: process.pid,
			purpose,
			wasBooted: existing?.wasBooted ?? wasBooted,
		};
		state.devices[device.udid] = lease;
		return lease;
	});
	claimedHere.add(device.udid);
	return lease;
}

/**
 * UDIDs leased by *this* process right now.
 *
 * The ledger cannot express this: it records one holder pid, so two sessions
 * in the same MCP instance look identical to it. Without this set, opening two
 * simulator sessions could hand out the same device and closing one would
 * shut the other's target down.
 */
const claimedHere = new Set<string>();

/**
 * A scratch device we created that nothing is currently holding.
 *
 * "Nothing" includes this process: two `ios_session open` calls in one MCP
 * instance must not be handed the same device, or closing the first would shut
 * the second's target down underneath it.
 */
async function findIdleScratch(runtimeId: string, deviceTypeId: string): Promise<SimDevice | null> {
	const state = await withLedger((current) => current);
	const devices = await listSimulators();
	for (const device of devices) {
		const lease = state.devices[device.udid];
		if (!lease || lease.provenance !== "created") continue;
		if (device.runtimeId !== runtimeId) continue;
		if (deviceTypeId && device.deviceTypeId && device.deviceTypeId !== deviceTypeId) continue;
		if (!unheld(lease)) continue;
		return device;
	}
	return null;
}

/**
 * Delete the oldest *unheld* scratch devices until we are back under the
 * ceiling. A device someone is still using is never a candidate, however old
 * its lease looks — the ceiling exists to stop accumulation, not to preempt
 * running work.
 */
async function enforceScratchCeiling(): Promise<void> {
	const state = await withLedger((current) => current);
	const mine = Object.values(state.devices)
		.filter((lease) => lease.provenance === "created")
		.sort((a, b) => a.acquiredAt - b.acquiredAt);
	const free = mine.filter(unheld);
	let over = mine.length - (MAX_SCRATCH_DEVICES - 1);
	for (const lease of free) {
		if (over <= 0) break;
		await destroyOwned(lease);
		over -= 1;
	}
}

export interface ReleaseOptions {
	/** Delete the device instead of leaving it shut down for reuse. */
	destroy?: boolean;
}

export interface ReleaseOutcome {
	udid: string;
	action: "deleted" | "shutdown" | "left-running" | "not-leased";
	reason: string;
}

/**
 * Give a device back. Adopted devices are only returned to the state we found
 * them in — never deleted, and only shut down if we were the ones who booted
 * them.
 */
export async function releaseSimulator(udid: string, options: ReleaseOptions = {}): Promise<ReleaseOutcome> {
	// Take the lease over atomically before touching the device: another
	// lazy-ios instance may be mid-run against it, and `destroy` is instant.
	const lease = await seizeLease(udid);
	if (!lease) {
		claimedHere.delete(udid);
		return { udid, action: "not-leased", reason: "no lease recorded — left untouched" };
	}

	if (lease.provenance === "adopted") {
		// Only shut down what we booted; an adopted device that was already
		// running is left exactly as we found it.
		if (!lease.wasBooted) await shutdown(udid);
		await withLedger((state) => {
			delete state.devices[udid];
		});
		claimedHere.delete(udid);
		return lease.wasBooted
			? { udid, action: "left-running", reason: "adopted device was already booted before lazy-ios touched it" }
			: { udid, action: "shutdown", reason: "adopted device booted by lazy-ios, restored to shutdown" };
	}

	if (options.destroy) {
		await destroyOwned(lease);
		return { udid, action: "deleted", reason: "scratch device destroyed on request" };
	}
	await shutdown(udid);
	await withLedger((state) => {
		const entry = state.devices[udid];
		if (entry) {
			entry.holderPid = 0;
			entry.expiresAt = Date.now();
		}
	});
	claimedHere.delete(udid);
	return { udid, action: "shutdown", reason: "scratch device kept shut down for reuse" };
}

/**
 * Atomically become the holder of a lease, or refuse.
 *
 * This is the compare-and-swap that every destructive path must go through.
 * Reading the ledger, deciding, and then deleting is not enough: between the
 * snapshot and the `simctl delete`, another lazy-ios instance can claim the
 * device and start a run on it. Taking the lease inside the lock means a
 * concurrent `claim` sees us as the live holder and backs off.
 *
 * Returns null when there is no lease at all. Throws when a *live* process
 * other than us holds it — regardless of the deadline, because expiry is not
 * evidence that a run has finished.
 */
async function seizeLease(udid: string): Promise<DeviceLease | null> {
	return await withLedger((state) => {
		const entry = state.devices[udid];
		if (!entry) return null;
		if (entry.holderPid !== process.pid && !unheld(entry)) {
			throw new Error(
				`refusing to touch ${udid}: held by live pid ${entry.holderPid} (lease until ${new Date(entry.expiresAt).toISOString()})`,
			);
		}
		entry.holderPid = process.pid;
		return { ...entry };
	});
}

/**
 * Delete a scratch device. Two gates: provenance must be "created", and the
 * lease must be seizable — we never delete a device a live process holds.
 */
async function destroyOwned(lease: DeviceLease): Promise<void> {
	if (lease.provenance !== "created") {
		throw new Error(`refusing to delete ${lease.udid}: provenance is "${lease.provenance}", not "created"`);
	}
	const seized = await seizeLease(lease.udid);
	if (!seized) return;
	if (seized.provenance !== "created") {
		throw new Error(`refusing to delete ${lease.udid}: provenance changed to "${seized.provenance}"`);
	}
	await shutdown(lease.udid).catch(() => undefined);
	const deleted = await run(["xcrun", "simctl", "delete", lease.udid], { timeout: 120_000 });
	// Dropping the record after a failed delete would orphan the device: it
	// would still exist, and nothing would remember that we may reclaim it.
	if (deleted.code !== 0 && !/Invalid device|Unable to find/i.test(`${deleted.stderr}${deleted.stdout}`)) {
		await withLedger((state) => {
			const entry = state.devices[lease.udid];
			if (entry) entry.holderPid = 0;
		});
		throw new Error(`simctl delete ${lease.udid} failed: ${(deleted.stderr || deleted.stdout).trim().slice(0, 300)}`);
	}
	await withLedger((state) => {
		delete state.devices[lease.udid];
	});
	claimedHere.delete(lease.udid);
}

export interface ReapReport {
	inspected: number;
	released: ReleaseOutcome[];
	/** Ledger entries whose device no longer exists; the entry is dropped. */
	pruned: string[];
	/** Live holders past their deadline. Reported only — never reclaimed. */
	overdue: Array<{ udid: string; holderPid: number; overdueMs: number; purpose: string }>;
	/** Leases that could not be reclaimed, with the reason. */
	skipped: Array<{ udid: string; reason: string }>;
}

/**
 * Reclaim every lease whose holder is gone.
 *
 * "Gone" means the pid is dead or the lease was explicitly released — never
 * merely that a deadline passed, because a long `keepOpen` session or a slow
 * test suite is still using its device. Overdue live leases are reported so a
 * human can look, and left alone.
 */
export async function reapSimulators(options: { destroyScratch?: boolean } = {}): Promise<ReapReport> {
	const state = await withLedger((current) => current);
	const candidates = reclaimable(state);
	const live = new Set((await listSimulators()).map((device) => device.udid));
	const released: ReleaseOutcome[] = [];
	const pruned: string[] = [];
	const skipped: ReapReport["skipped"] = [];
	const now = Date.now();

	for (const lease of candidates) {
		if (!live.has(lease.udid)) {
			await withLedger((current) => {
				delete current.devices[lease.udid];
			});
			claimedHere.delete(lease.udid);
			pruned.push(lease.udid);
			continue;
		}
		try {
			// Always go through releaseSimulator: it re-seizes the lease inside
			// the ledger lock. `candidates` is a snapshot, and between taking it
			// and acting another process can legitimately claim the device —
			// shutting it down from here would kill a live run.
			released.push(await releaseSimulator(lease.udid, { destroy: options.destroyScratch }));
		} catch (error) {
			// A device that resists teardown keeps its ledger entry so the next
			// reap tries again; silently dropping it would orphan it.
			skipped.push({ udid: lease.udid, reason: (error as Error).message });
		}
	}

	return {
		inspected: candidates.length,
		released,
		pruned,
		overdue: overdue(state, now).map((lease) => ({
			udid: lease.udid,
			holderPid: lease.holderPid,
			overdueMs: now - lease.expiresAt,
			purpose: lease.purpose,
		})),
		skipped,
	};
}

export async function installApp(udid: string, appPath: string): Promise<void> {
	await runOk(["xcrun", "simctl", "install", udid, appPath], { timeout: 300_000 });
}

export async function launchApp(
	udid: string,
	bundleId: string,
	options: { relaunch?: boolean; args?: readonly string[] } = {},
): Promise<number> {
	const argv = ["xcrun", "simctl", "launch"];
	if (options.relaunch) argv.push("--terminate-running-process");
	argv.push(udid, bundleId, ...(options.args ?? []));
	const result = await runOk(argv, { timeout: 120_000 });
	const pid = /:\s*(\d+)\s*$/.exec(result.stdout.trim());
	return pid ? Number.parseInt(pid[1]!, 10) : 0;
}

export async function terminateApp(udid: string, bundleId: string): Promise<void> {
	await run(["xcrun", "simctl", "terminate", udid, bundleId], { timeout: 60_000 });
}

/**
 * Booted simulators that lazy-ios does not own — reported by the doctor so the
 * user can see machine-wide pressure without lazy-ios ever touching them.
 */
export async function foreignBooted(): Promise<SimDevice[]> {
	const state = await withLedger((current) => current);
	const devices = await listSimulators();
	return devices.filter((device) => device.state === "Booted" && !state.devices[device.udid]);
}
