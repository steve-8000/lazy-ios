/**
 * Session registry: the thing that actually stops the leaks.
 *
 * A session binds a target (scratch simulator or physical device) to whatever
 * else had to be started for it — a WebDriver session, an Appium server — and
 * owns tearing all of it down. Three independent triggers close a session, so
 * no single missed call strands a booted simulator:
 *
 *   1. explicit `ios_session close` / the end of `ios_run`
 *   2. an idle sweep inside this process
 *   3. process exit (SIGINT/SIGTERM/uncaught), which releases everything held
 *
 * and the ledger catches whatever survives all three, because the next run
 * reaps leases whose holder pid is gone.
 */

import { mkdirSync } from "node:fs";

import { killChildren } from "./core/exec.ts";
import { LAZY_HOME, renewLease } from "./core/ledger.ts";
import {
	type AppiumServer,
	type WebDriverSession,
	createRealDeviceSession,
	deleteSession,
	ensureAppium,
} from "./ios/appium.ts";
import {
	type PreflightResult,
	type RealDevice,
	findRealDevice,
	findSignedWda,
	preflightRealDevice,
} from "./ios/device.ts";
import { type AcquiredSimulator, acquireSimulator, releaseSimulator } from "./ios/simulator.ts";
import { DeviceDriver, SimulatorDriver, type UiDriver } from "./ui/driver.ts";

export type TargetKind = "simulator" | "device";

export interface Session {
	id: string;
	kind: TargetKind;
	/** Simulator UDID or hardware UDID. */
	udid: string;
	name: string;
	runtime: string;
	driver: UiDriver;
	createdAt: number;
	lastUsedAt: number;
	idleTimeoutMs: number;
	purpose: string;
	/** Present for simulator sessions. */
	simulator?: AcquiredSimulator;
	/** Present for device sessions. */
	device?: RealDevice;
	webdriver?: WebDriverSession;
	appium?: AppiumServer;
	/** Bundle id of the app under test, once one is installed or launched. */
	bundleId?: string;
	/** Set while teardown is in flight; blocks the idle sweeper from racing it. */
	closing?: boolean;
	/** The single in-flight teardown. Concurrent closers await this one. */
	teardown?: Promise<CloseOutcome>;
	/** Last teardown failure. Non-empty means the device is still held. */
	teardownError?: string;
}

const sessions = new Map<string, Session>();
const DEFAULT_IDLE_MS = 15 * 60_000;
let sweeper: ReturnType<typeof setInterval> | null = null;
let shutdownWired = false;

for (const directory of ["logs", "evidence", "results", "derived"]) {
	mkdirSync(`${LAZY_HOME}/${directory}`, { recursive: true });
}

export function listSessions(): Session[] {
	return [...sessions.values()];
}

export function getSession(id: string): Session {
	const session = sessions.get(id);
	if (!session) {
		const known = [...sessions.keys()];
		throw new Error(`unknown session "${id}"${known.length ? ` (open: ${known.join(", ")})` : " (none open)"}`);
	}
	// Teardown in flight: the device may already be shut down, so driving it
	// would either hang or act on a device we no longer own.
	if (session.closing) throw new Error(`session "${id}" is being closed`);
	session.lastUsedAt = Date.now();
	// Push the ledger deadline out too. The deadline is what a human reads to
	// judge whether a run has gone wrong; without renewal, a long interactive
	// session would show as overdue forever. Renewal is advisory: a failure
	// must not reject into the MCP stdio loop and kill the server.
	if (session.kind === "simulator") {
		void renewLease(session.udid, leaseTtl(session.idleTimeoutMs)).catch(() => undefined);
	}
	return session;
}

/** Ledger lease length for a given idle budget: generous, but finite. */
function leaseTtl(idleTimeoutMs: number): number {
	return Math.max(idleTimeoutMs * 2, 30 * 60_000);
}

/**
 * Ids handed out but not yet registered.
 *
 * `sessions` only gains an entry after the device is acquired, which is many
 * awaits later; until then a concurrent open sees the id as free.
 */
const reservedIds = new Set<string>();

function reserveSessionId(kind: TargetKind): string {
	for (;;) {
		const id = `${kind}-${crypto.randomUUID().slice(0, 8)}`;
		if (sessions.has(id) || reservedIds.has(id)) continue;
		reservedIds.add(id);
		return id;
	}
}

export interface OpenSimulatorRequest {
	kind: "simulator";
	udid?: string;
	runtime?: string;
	deviceType?: string;
	purpose?: string;
	idleTimeoutMs?: number;
	fresh?: boolean;
}

export interface OpenDeviceRequest {
	kind: "device";
	udid?: string;
	bundleId?: string;
	purpose?: string;
	idleTimeoutMs?: number;
	/** Skip preflight gating. Only for diagnosing preflight itself. */
	force?: boolean;
}

export type OpenRequest = OpenSimulatorRequest | OpenDeviceRequest;

export class PreflightBlocked extends Error {
	constructor(
		message: string,
		readonly report: PreflightResult,
	) {
		super(message);
		this.name = "PreflightBlocked";
	}
}

export async function openSession(request: OpenRequest): Promise<Session> {
	wireShutdown();
	// Reserve the id synchronously, before the first await, and hold the
	// reservation until the session is registered. A collision silently
	// replaces the earlier session in the registry, and its device is then
	// held by a lease nobody will ever release — measured once, with
	// `Bun.randomUUIDv7().slice(0, 8)`, whose leading digits are the
	// millisecond timestamp and so are identical for concurrent opens.
	// Checking the registry alone is not enough: a concurrent open has not
	// registered yet either.
	const id = reserveSessionId(request.kind);
	try {
		return await openReserved(id, request);
	} finally {
		// Once registered the id lives in `sessions`; on failure it goes back
		// into circulation. Either way the reservation is done its job.
		reservedIds.delete(id);
	}
}

async function openReserved(id: string, request: OpenRequest): Promise<Session> {
	const purpose = request.purpose ?? "lazy-ios session";
	const idleTimeoutMs = request.idleTimeoutMs ?? DEFAULT_IDLE_MS;

	if (request.kind === "simulator") {
		const acquired = await acquireSimulator({
			udid: request.udid,
			runtime: request.runtime,
			deviceType: request.deviceType,
			purpose,
			fresh: request.fresh,
			ttl: leaseTtl(idleTimeoutMs),
		});
		const session: Session = {
			id,
			kind: "simulator",
			udid: acquired.device.udid,
			name: acquired.device.name,
			runtime: acquired.device.runtime,
			driver: new SimulatorDriver(acquired.device.udid),
			createdAt: Date.now(),
			lastUsedAt: Date.now(),
			idleTimeoutMs,
			purpose,
			simulator: acquired,
		};
		sessions.set(id, session);
		return session;
	}

	const report = await preflightRealDevice({ udid: request.udid });
	if (!report.ready && !request.force) {
		throw new PreflightBlocked(
			`real device is not ready: ${report.checks
				.filter((check) => check.severity === "blocked")
				.map((check) => check.title)
				.join(", ")}`,
			report,
		);
	}
	const device = report.device ?? (await findRealDevice(request.udid));
	if (!device) throw new Error("no physical iOS device found");

	const appium = await ensureAppium();
	const wda = findSignedWda()[0];
	let webdriver: WebDriverSession | undefined;
	try {
		webdriver = await createRealDeviceSession(appium, {
			udid: device.udid,
			bundleId: request.bundleId,
			prebuiltWdaPath: wda?.path,
		});
		const session: Session = {
			id,
			kind: "device",
			udid: device.udid,
			name: device.name,
			runtime: `${device.platform} ${device.osVersion}`,
			driver: new DeviceDriver(device.udid, webdriver),
			createdAt: Date.now(),
			lastUsedAt: Date.now(),
			idleTimeoutMs,
			purpose,
			device,
			webdriver,
			appium,
			bundleId: request.bundleId,
		};
		sessions.set(id, session);
		return session;
	} catch (error) {
		// A half-created device session leaves a live WDA session on the phone
		// that nothing in the registry knows about; drop it before rethrowing.
		if (webdriver) await deleteSession(webdriver).catch(() => undefined);
		throw error;
	}
}

export interface CloseOutcome {
	id: string;
	kind: TargetKind;
	udid: string;
	/** What happened to the target device. */
	device: string;
	webdriver: "closed" | "none";
}

/**
 * Give a session back.
 *
 * The session stays in the registry until teardown actually succeeds. Dropping
 * it first would be worse than not trying: this process would still be the
 * lease holder in the ledger, so `reapSimulators` would treat the device as
 * live, while nothing in memory remembered to retry — a booted simulator with
 * no owner willing to release it.
 */
export async function closeSession(id: string, options: { destroy?: boolean } = {}): Promise<CloseOutcome> {
	const session = sessions.get(id);
	if (!session) throw new Error(`unknown session "${id}"`);
	// An explicit close racing the idle sweeper, or `closeAll` racing a manual
	// close, must not both tear the same device down: the second `seizeLease`
	// would succeed (same pid) and shut down or delete a device the first call
	// has already released. Join the teardown already in flight instead.
	if (session.teardown) return await session.teardown;

	const teardown = performTeardown(id, session, options);
	session.teardown = teardown;
	return await teardown;
}

async function performTeardown(
	id: string,
	session: Session,
	options: { destroy?: boolean },
): Promise<CloseOutcome> {
	session.closing = true;

	try {
		let webdriver: CloseOutcome["webdriver"] = "none";
		if (session.webdriver) {
			await deleteSession(session.webdriver);
			webdriver = "closed";
		}
		let device = "left as found";
		if (session.kind === "simulator") {
			const outcome = await releaseSimulator(session.udid, { destroy: options.destroy });
			device = `${outcome.action}: ${outcome.reason}`;
		}
		sessions.delete(id);
		return { id, kind: session.kind, udid: session.udid, device, webdriver };
	} catch (error) {
		// Clear `closing` so the idle sweeper retries. Leaving it set would make
		// one failed teardown permanent for the process's lifetime — the device
		// stays booted and nothing automatic ever tries again.
		session.closing = false;
		// Drop the shared handle too, or every later retry would re-await this
		// same rejected promise and never actually try again.
		session.teardown = undefined;
		session.teardownError = (error as Error).message;
		throw error;
	}
}

export interface CloseAllReport {
	closed: CloseOutcome[];
	/** Sessions whose teardown failed. They remain open and retryable. */
	pending: Array<{ id: string; udid: string; error: string }>;
}

export async function closeAll(options: { destroy?: boolean } = {}): Promise<CloseAllReport> {
	const closed: CloseOutcome[] = [];
	const pending: CloseAllReport["pending"] = [];
	for (const id of [...sessions.keys()]) {
		try {
			closed.push(await closeSession(id, options));
		} catch (error) {
			// One stuck device must not strand the rest, but it is reported and
			// stays in the registry so the next ios_cleanup retries it.
			pending.push({ id, udid: sessions.get(id)?.udid ?? "", error: (error as Error).message });
		}
	}
	return { closed, pending };
}

/** Close sessions nobody has touched within their idle budget. */
export async function sweepIdle(): Promise<CloseAllReport> {
	const now = Date.now();
	const stale = [...sessions.values()].filter(
		(session) => !session.closing && now - session.lastUsedAt > session.idleTimeoutMs,
	);
	const closed: CloseOutcome[] = [];
	const pending: CloseAllReport["pending"] = [];
	for (const session of stale) {
		try {
			closed.push(await closeSession(session.id));
		} catch (error) {
			pending.push({ id: session.id, udid: session.udid, error: (error as Error).message });
		}
	}
	return { closed, pending };
}

function wireShutdown(): void {
	if (shutdownWired) return;
	shutdownWired = true;

	sweeper = setInterval(() => {
		void sweepIdle();
	}, 60_000);
	sweeper.unref?.();

	// Synchronous-enough teardown: simctl shutdown is fast, and leaving a
	// booted scratch device behind is precisely the bug this project fixes.
	const bail = (signal: NodeJS.Signals): void => {
		// `run` spawns children into their own process group so a timeout can
		// reach descendants; the cost is that they no longer die with our group.
		// An interrupted build would otherwise leave xcodebuild and its
		// compilers running, and they would still be writing into a DerivedData
		// tree whose simulator we are about to release.
		killChildren();
		void closeAll().finally(() => {
			process.exit(signal === "SIGINT" ? 130 : 143);
		});
	};
	process.once("SIGINT", bail);
	process.once("SIGTERM", bail);
	process.once("beforeExit", () => {
		killChildren();
		void closeAll();
	});
}
