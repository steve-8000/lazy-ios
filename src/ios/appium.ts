/**
 * Supervised Appium server plus a minimal W3C WebDriver client.
 *
 * Two deliberate choices:
 *
 * 1. lazy-ios runs *one* Appium server, recorded in the ledger, reused across
 *    MCP client reconnects. The machine this was built on had five orphaned
 *    `appium-mcp` processes and two stray `appium` servers on 4723/4725; one
 *    supervised process with a recorded pid is the fix.
 *
 * 2. There is no MCP-proxying of appium-mcp. Appium already speaks plain W3C
 *    WebDriver over HTTP, so a ~150 line client removes an entire child MCP
 *    process, its own session bookkeeping, and its independent idea of when to
 *    tear things down.
 */

import { run, waitFor } from "../core/exec.ts";
import { type ProcessRecord, isAlive, withLedger } from "../core/ledger.ts";
import { APPIUM_HOME } from "./device.ts";

const LEDGER_KEY = "appium";
const DEFAULT_PORT = 4737;
const START_TIMEOUT_MS = 60_000;

export interface AppiumServer {
	pid: number;
	port: number;
	baseUrl: string;
	/** True when this call started the process rather than reusing one. */
	started: boolean;
}

async function statusOk(port: number): Promise<true | null> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2_000) });
		return response.ok ? true : null;
	} catch {
		return null;
	}
}

/**
 * Return the supervised server, starting it if needed.
 * `restart` forces a fresh process — required after installing
 * `appium-ios-remotexpc`, whose absence the driver caches per-process.
 */
export async function ensureAppium(options: { port?: number; restart?: boolean } = {}): Promise<AppiumServer> {
	const port = options.port ?? Number.parseInt(process.env.LAZY_IOS_APPIUM_PORT ?? String(DEFAULT_PORT), 10);
	const recorded = await withLedger((state) => state.processes[LEDGER_KEY]);

	if (recorded && isAlive(recorded.pid) && !options.restart) {
		if (await statusOk(recorded.port ?? port)) {
			const livePort = recorded.port ?? port;
			return { pid: recorded.pid, port: livePort, baseUrl: `http://127.0.0.1:${livePort}`, started: false };
		}
	}
	if (recorded && isAlive(recorded.pid)) await stopAppium();

	// Someone else's server on our port is fine to reuse only if it answers.
	if (!options.restart && (await statusOk(port))) {
		return { pid: 0, port, baseUrl: `http://127.0.0.1:${port}`, started: false };
	}

	// Loopback only, and no `--relaxed-security`: this server can install and
	// drive apps on a physical phone, so it must not be reachable from the LAN
	// and must not enable the blanket insecure-feature set. Anything lazy-ios
	// genuinely needs is opted into by name via LAZY_IOS_ALLOW_INSECURE.
	const allowInsecure = (process.env.LAZY_IOS_ALLOW_INSECURE ?? "").trim();
	const argv = [
		"appium",
		"--address",
		"127.0.0.1",
		"--port",
		String(port),
		"--base-path",
		"/",
		"--log-level",
		"warn",
		"--log-timestamp",
		...(allowInsecure ? ["--allow-insecure", allowInsecure] : []),
	];
	const child = Bun.spawn(argv, {
		env: { ...process.env, APPIUM_HOME },
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		// Detached so the server survives an MCP client disconnect; the ledger
		// keeps the pid so the next run adopts it instead of starting another.
		detached: true,
	});
	child.unref();

	// Fingerprint the process now, not after the readiness wait: `ps` reports
	// the real start time, and a first-run Appium can take 30 s to answer
	// /status. Recording the post-readiness clock would make every later
	// identity check fail, and a failing check means we never stop our own
	// server — the exact leak this file exists to prevent.
	const startedAt = Date.now();
	const lstart = await processStartLine(child.pid);

	const up = await waitFor(() => statusOk(port), { timeout: START_TIMEOUT_MS, interval: 400 });
	if (!up) {
		child.kill("SIGKILL");
		throw new Error(`Appium did not answer /status on port ${port} within ${START_TIMEOUT_MS}ms`);
	}

	await withLedger((state) => {
		state.processes[LEDGER_KEY] = { key: LEDGER_KEY, pid: child.pid, port, startedAt, lstart, argv };
	});
	return { pid: child.pid, port, baseUrl: `http://127.0.0.1:${port}`, started: true };
}

/**
 * `ps -o lstart=` for a pid, or "" when it is gone.
 *
 * `LC_ALL=C` because the field is `strftime("%c")`: under a Korean locale it
 * comes back as "2026년 9월 8일 ..." and any parse of it fails, which would
 * silently turn the identity check below into "never matches".
 */
async function processStartLine(pid: number): Promise<string> {
	const probe = await run(["/bin/ps", "-o", "lstart=", "-p", String(pid)], {
		timeout: 10_000,
		env: { LC_ALL: "C" },
	});
	return probe.code === 0 ? probe.stdout.trim() : "";
}

/**
 * Confirm the pid still *is* the process we recorded.
 *
 * macOS reuses pids freely, so "the ledger says 12345 and 12345 is alive" is
 * not evidence. Compare the start line captured at spawn — an exact string
 * match, no clock arithmetic, so a slow startup cannot make this drift.
 *
 * The failure direction matters: refusing to signal our own server is worse
 * than the pid-reuse case it guards against, because it recreates the helper
 * leak. Hence the command-line fallback when no start line was captured.
 */
async function identityMatches(record: ProcessRecord): Promise<boolean> {
	if (record.lstart) {
		const current = await processStartLine(record.pid);
		return current !== "" && current === record.lstart;
	}
	const probe = await run(["/bin/ps", "-o", "command=", "-p", String(record.pid)], {
		timeout: 10_000,
		env: { LC_ALL: "C" },
	});
	if (probe.code !== 0) return false;
	const command = probe.stdout.trim();
	const port = record.argv[record.argv.indexOf("--port") + 1];
	return /\bappium\b/.test(command) && (!port || command.includes(port));
}

export async function stopAppium(): Promise<{ stopped: boolean; pid: number; reason: string }> {
	const record = await withLedger((state) => state.processes[LEDGER_KEY]);
	if (!record) return { stopped: false, pid: 0, reason: "no supervised Appium recorded" };

	// The record is only dropped once we know the process is gone. Clearing it
	// first and then failing the identity check would leave a live server that
	// nothing remembers how to stop.
	const forget = async (): Promise<void> => {
		await withLedger((state) => {
			if (state.processes[LEDGER_KEY]?.pid === record.pid) delete state.processes[LEDGER_KEY];
		});
	};

	if (!isAlive(record.pid)) {
		await forget();
		return { stopped: false, pid: record.pid, reason: "recorded pid already gone; ledger cleared" };
	}
	if (!(await identityMatches(record))) {
		await forget();
		return {
			stopped: false,
			pid: record.pid,
			reason: `pid ${record.pid} belongs to a different process now; ledger cleared without signalling`,
		};
	}
	await run(["/bin/kill", "-TERM", String(record.pid)], { timeout: 10_000 });
	const gone = await waitFor(async () => (isAlive(record.pid) ? null : true), { timeout: 8_000, interval: 200 });
	if (!gone) {
		await run(["/bin/kill", "-KILL", String(record.pid)], { timeout: 10_000 });
		await waitFor(async () => (isAlive(record.pid) ? null : true), { timeout: 5_000, interval: 200 });
	}
	if (isAlive(record.pid)) {
		return { stopped: false, pid: record.pid, reason: "still alive after SIGKILL; ledger record kept for retry" };
	}
	await forget();
	return { stopped: true, pid: record.pid, reason: gone ? "terminated" : "killed after SIGTERM timeout" };
}

// ── W3C WebDriver ───────────────────────────────────────────────────────────

export interface WebDriverSession {
	sessionId: string;
	baseUrl: string;
	capabilities: Record<string, unknown>;
}

interface WireResponse<T> {
	value: T;
}

export class WebDriverError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly payload: unknown,
	) {
		super(message);
		this.name = "WebDriverError";
	}
}

async function call<T>(
	baseUrl: string,
	method: "GET" | "POST" | "DELETE",
	path: string,
	body?: unknown,
	timeoutMs = 120_000,
): Promise<T> {
	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers: body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await response.text();
	let payload: unknown;
	try {
		payload = text ? JSON.parse(text) : {};
	} catch {
		throw new WebDriverError(`non-JSON response from ${path}: ${text.slice(0, 300)}`, response.status, text);
	}
	// Every W3C reply is `{"value": …}`; anything else is a proxy or a crash page.
	if (!(payload && typeof payload === "object" && "value" in payload)) {
		throw new WebDriverError(`malformed WebDriver reply from ${path}`, response.status, payload);
	}
	const value: unknown = payload.value;
	if (!response.ok) {
		const detail =
			value && typeof value === "object"
				? [
						"error" in value && typeof value.error === "string" ? value.error : response.statusText,
						"message" in value && typeof value.message === "string" ? value.message.split("\n")[0] : "",
					]
						.filter(Boolean)
						.join(": ")
				: response.statusText;
		throw new WebDriverError(detail, response.status, payload);
	}
	return value as T;
}

export interface RealDeviceSessionOptions {
	udid: string;
	bundleId?: string;
	/** Signed WDA IPA from the appium-mcp signing pipeline. */
	prebuiltWdaPath?: string;
	wdaBundleId?: string;
	xcodeOrgId?: string;
	xcodeSigningId?: string;
	wdaLaunchTimeout?: number;
	newCommandTimeout?: number;
}

/**
 * Create an XCUITest session against a physical device.
 *
 * `usePreinstalledWDA` + `prebuiltWDAPath` is the path that works on this
 * machine *once the RemoteXPC tunnel exists*; without the tunnel the driver
 * reports "RemoteXPC is not available for this session" no matter what else is
 * configured, which is why `preflightRealDevice` gates this call.
 */
export async function createRealDeviceSession(
	server: AppiumServer,
	options: RealDeviceSessionOptions,
): Promise<WebDriverSession> {
	const capabilities: Record<string, unknown> = {
		platformName: "iOS",
		"appium:automationName": "XCUITest",
		"appium:udid": options.udid,
		"appium:noReset": true,
		"appium:wdaLaunchTimeout": options.wdaLaunchTimeout ?? 180_000,
		"appium:newCommandTimeout": options.newCommandTimeout ?? 600,
	};
	if (options.bundleId) capabilities["appium:bundleId"] = options.bundleId;
	if (options.prebuiltWdaPath) {
		capabilities["appium:usePreinstalledWDA"] = true;
		capabilities["appium:prebuiltWDAPath"] = options.prebuiltWdaPath;
	}
	if (options.wdaBundleId) capabilities["appium:updatedWDABundleId"] = options.wdaBundleId;
	if (options.xcodeOrgId) capabilities["appium:xcodeOrgId"] = options.xcodeOrgId;
	if (options.xcodeSigningId) capabilities["appium:xcodeSigningId"] = options.xcodeSigningId ?? "Apple Development";

	const value = await call<{ sessionId: string; capabilities: Record<string, unknown> }>(
		server.baseUrl,
		"POST",
		"/session",
		{ capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } },
		(options.wdaLaunchTimeout ?? 180_000) + 60_000,
	);
	return { sessionId: value.sessionId, baseUrl: server.baseUrl, capabilities: value.capabilities };
}

export async function deleteSession(session: WebDriverSession): Promise<void> {
	await call<unknown>(session.baseUrl, "DELETE", `/session/${session.sessionId}`, undefined, 60_000).catch(
		() => undefined,
	);
}

export async function sessionAlive(session: WebDriverSession): Promise<boolean> {
	try {
		await call<unknown>(session.baseUrl, "GET", `/session/${session.sessionId}/window/rect`, undefined, 15_000);
		return true;
	} catch {
		return false;
	}
}

export async function pageSource(session: WebDriverSession): Promise<string> {
	return await call<string>(session.baseUrl, "GET", `/session/${session.sessionId}/source`);
}

export async function screenshotBase64(session: WebDriverSession): Promise<string> {
	return await call<string>(session.baseUrl, "GET", `/session/${session.sessionId}/screenshot`);
}

export async function windowRect(session: WebDriverSession): Promise<{ width: number; height: number }> {
	return await call<{ width: number; height: number }>(session.baseUrl, "GET", `/session/${session.sessionId}/window/rect`);
}

export async function findElement(
	session: WebDriverSession,
	using: string,
	value: string,
): Promise<string | null> {
	try {
		const element = await call<Record<string, string>>(session.baseUrl, "POST", `/session/${session.sessionId}/element`, {
			using,
			value,
		});
		return Object.values(element)[0] ?? null;
	} catch (error) {
		if (error instanceof WebDriverError && error.status === 404) return null;
		throw error;
	}
}

export async function clickElement(session: WebDriverSession, elementId: string): Promise<void> {
	await call<unknown>(session.baseUrl, "POST", `/session/${session.sessionId}/element/${elementId}/click`, {});
}

export async function sendKeys(session: WebDriverSession, elementId: string, text: string): Promise<void> {
	await call<unknown>(session.baseUrl, "POST", `/session/${session.sessionId}/element/${elementId}/value`, {
		text,
		value: [...text],
	});
}

/** W3C pointer actions — the portable way to tap and swipe at coordinates. */
export async function pointerActions(
	session: WebDriverSession,
	actions: Array<Record<string, unknown>>,
): Promise<void> {
	await call<unknown>(session.baseUrl, "POST", `/session/${session.sessionId}/actions`, {
		actions: [{ type: "pointer", id: "finger1", parameters: { pointerType: "touch" }, actions }],
	});
}

export async function execute(session: WebDriverSession, script: string, args: unknown[] = []): Promise<unknown> {
	return await call<unknown>(session.baseUrl, "POST", `/session/${session.sessionId}/execute/sync`, { script, args });
}

export async function installOnDevice(session: WebDriverSession, appPath: string): Promise<void> {
	await call<unknown>(session.baseUrl, "POST", `/session/${session.sessionId}/appium/device/install_app`, {
		appPath,
	}, 600_000);
}

export async function activateApp(session: WebDriverSession, bundleId: string): Promise<void> {
	await call<unknown>(session.baseUrl, "POST", `/session/${session.sessionId}/appium/device/activate_app`, {
		bundleId,
		appId: bundleId,
	});
}

export async function terminateOnDevice(session: WebDriverSession, bundleId: string): Promise<void> {
	await call<unknown>(session.baseUrl, "POST", `/session/${session.sessionId}/appium/device/terminate_app`, {
		bundleId,
		appId: bundleId,
	});
}
