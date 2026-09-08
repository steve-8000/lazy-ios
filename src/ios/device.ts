/**
 * Real-device discovery and preflight.
 *
 * The failure this encodes was diagnosed on this machine and written up in
 * folio-v2/Docs/ios-real-device-automation-setup.md: five consecutive session
 * failures reported
 *
 *   Failed to launch the preinstalled WebDriverAgent via RemoteXPC:
 *   RemoteXPC is not available for this session
 *
 * which reads like "no tunnel" but is also what a *missing optional package*
 * produces. `appium-xcuitest-driver` loads `appium-ios-remotexpc` lazily and
 * caches the failure for the lifetime of the process, so the same server keeps
 * failing after the package is installed.
 *
 * The point of preflight is that every one of those conditions is cheaply
 * observable *before* a session is attempted, and the report says which one is
 * false. Nothing here runs `sudo`: the tunnel step needs root and is left to
 * the human, with the exact command to paste.
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { run, runJson } from "../core/exec.ts";

export const DEFAULT_TUNNEL_REGISTRY_PORT = 42314;
export const APPIUM_HOME = process.env.APPIUM_HOME ?? join(homedir(), ".appium");

export interface RealDevice {
	/** Hardware UDID — the only identifier Appium/WDA accept. */
	udid: string;
	/** CoreDevice UUID used by `devicectl --device`. Not interchangeable. */
	coreDeviceId: string;
	name: string;
	osVersion: string;
	platform: string;
	connected: boolean;
	transport: string;
	developerMode: "enabled" | "disabled" | "unknown";
	paired: boolean;
}

interface DevicectlDump {
	result?: {
		devices?: Array<{
			identifier?: string;
			hardwareProperties?: { udid?: string | null; platform?: string; ecid?: number | null };
			deviceProperties?: { name?: string; osVersionNumber?: string; developerModeStatus?: string | null };
			connectionProperties?: { tunnelState?: string; pairingState?: string; transportType?: string };
		}>;
	};
}

/** Physical iOS/iPadOS devices known to CoreDevice. Simulators are excluded. */
export async function listRealDevices(): Promise<RealDevice[]> {
	const out = join(process.env.TMPDIR ?? "/tmp", `lazy-ios-devicectl-${process.pid}.json`);
	const listed = await run(["xcrun", "devicectl", "list", "devices", "--json-output", out], { timeout: 45_000 });
	if (listed.code !== 0) return [];
	let dump: DevicectlDump;
	try {
		dump = JSON.parse(await Bun.file(out).text()) as DevicectlDump;
	} catch {
		return [];
	}
	const devices: RealDevice[] = [];
	for (const entry of dump.result?.devices ?? []) {
		const udid = entry.hardwareProperties?.udid;
		// Simulators appear in this list with a null hardware udid and no ECID.
		// The hardware UDID is the ECID-derived "00008150-0006…" form; anything
		// else is a CoreDevice UUID and would silently break an Appium session.
		if (!udid || entry.hardwareProperties?.ecid == null) continue;
		const platform = entry.hardwareProperties?.platform ?? "unknown";
		if (!/^(iOS|iPadOS)$/i.test(platform)) continue;
		const developerMode = entry.deviceProperties?.developerModeStatus;
		devices.push({
			udid,
			coreDeviceId: entry.identifier ?? "",
			name: entry.deviceProperties?.name ?? udid,
			osVersion: entry.deviceProperties?.osVersionNumber ?? "unknown",
			platform,
			connected: entry.connectionProperties?.tunnelState === "connected",
			transport: entry.connectionProperties?.transportType ?? "unknown",
			developerMode: developerMode === "enabled" ? "enabled" : developerMode === "disabled" ? "disabled" : "unknown",
			paired: entry.connectionProperties?.pairingState === "paired",
		});
	}
	return devices;
}

export async function findRealDevice(udid?: string): Promise<RealDevice | null> {
	const devices = await listRealDevices();
	if (udid) return devices.find((device) => device.udid === udid) ?? null;
	return devices.find((device) => device.connected) ?? devices[0] ?? null;
}

export type CheckSeverity = "ok" | "warn" | "blocked";

export interface Check {
	id: string;
	title: string;
	severity: CheckSeverity;
	detail: string;
	/** Shell command a human must run. Present only when we refuse to do it. */
	humanAction?: string;
	/** True when lazy-ios can fix this itself via `fix: true`. */
	autoFixable?: boolean;
}

interface TunnelRegistry {
	status?: string;
	tunnels?: Record<string, unknown>;
	metadata?: { totalTunnels?: number; activeTunnels?: number; lastUpdated?: string };
}

export async function readTunnelRegistry(
	port = DEFAULT_TUNNEL_REGISTRY_PORT,
): Promise<{ reachable: boolean; registry?: TunnelRegistry }> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/remotexpc/tunnels`, {
			signal: AbortSignal.timeout(3_000),
		});
		if (!response.ok) return { reachable: true };
		return { reachable: true, registry: (await response.json()) as TunnelRegistry };
	} catch {
		return { reachable: false };
	}
}

/** Does the registry hold a tunnel for this exact device? */
export function tunnelFor(registry: TunnelRegistry | undefined, udid: string): boolean {
	if (!registry?.tunnels) return false;
	if (Object.hasOwn(registry.tunnels, udid)) return true;
	// Some driver versions key by an internal id and carry the udid in the value.
	return JSON.stringify(registry.tunnels).includes(udid);
}

async function importsFromAppiumHome(specifier: string): Promise<{ ok: boolean; detail: string }> {
	const probe = `import(${JSON.stringify(specifier)}).then(()=>console.log("OK")).catch(e=>{console.log("ERR",e.message)})`;
	const result = await run(["node", "-e", probe], { cwd: APPIUM_HOME, timeout: 30_000 });
	const text = `${result.stdout}${result.stderr}`.trim();
	return { ok: text.startsWith("OK"), detail: text.slice(0, 300) || `node exited ${result.code}` };
}

/** Epoch ms the package directory was written, or 0 when it is absent. */
function installedAt(packageName: string): number {
	const path = join(APPIUM_HOME, "node_modules", packageName);
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

export interface PreflightResult {
	device: RealDevice | null;
	checks: Check[];
	ready: boolean;
	/** Commands the human must run, in order, before this can work. */
	humanActions: string[];
}

/**
 * Run every real-device precondition and report which are false.
 * Never mutates the machine; `ios_doctor(fix: true)` performs the subset that
 * is safe to automate.
 */
export async function preflightRealDevice(options: { udid?: string; tunnelPort?: number } = {}): Promise<PreflightResult> {
	const port = options.tunnelPort ?? DEFAULT_TUNNEL_REGISTRY_PORT;
	const checks: Check[] = [];
	const device = await findRealDevice(options.udid);

	if (!device) {
		checks.push({
			id: "device.present",
			title: "physical device attached",
			severity: "blocked",
			detail: options.udid
				? `no CoreDevice entry for udid ${options.udid}`
				: "no physical iOS device is known to CoreDevice",
			humanAction: "Connect the iPhone by cable, unlock it, and tap Trust when prompted.",
		});
		return { device: null, checks, ready: false, humanActions: checks.flatMap((c) => (c.humanAction ? [c.humanAction] : [])) };
	}

	checks.push({
		id: "device.present",
		title: "physical device attached",
		severity: device.connected ? "ok" : "blocked",
		detail: `${device.name} (${device.osVersion}, ${device.transport}) tunnelState=${device.connected ? "connected" : "disconnected"} udid=${device.udid}`,
		humanAction: device.connected ? undefined : "Reconnect the cable and unlock the device; CoreDevice reports it disconnected.",
	});

	checks.push({
		id: "device.developerMode",
		title: "developer mode enabled",
		severity: device.developerMode === "enabled" ? "ok" : device.developerMode === "unknown" ? "warn" : "blocked",
		detail: `developerModeStatus=${device.developerMode}`,
		humanAction:
			device.developerMode === "disabled"
				? "On the device: Settings > Privacy & Security > Developer Mode > On, then reboot."
				: undefined,
	});

	checks.push({
		id: "device.paired",
		title: "device paired with this Mac",
		severity: device.paired ? "ok" : "blocked",
		detail: `pairingState=${device.paired ? "paired" : "unpaired"}`,
		humanAction: device.paired ? undefined : "Unlock the device and tap Trust This Computer.",
	});

	const remotexpc = await importsFromAppiumHome("appium-ios-remotexpc");
	checks.push({
		id: "appium.remotexpc",
		title: "appium-ios-remotexpc installed",
		severity: remotexpc.ok ? "ok" : "blocked",
		detail: remotexpc.ok ? `importable from ${APPIUM_HOME}` : remotexpc.detail,
		autoFixable: !remotexpc.ok,
		humanAction: remotexpc.ok
			? undefined
			: `cd ${APPIUM_HOME} && npm install appium-ios-remotexpc@^5.18.2 && npm install-scripts approve appium-ios-tuntap && npm rebuild appium-ios-tuntap`,
	});

	const tuntap = await importsFromAppiumHome("appium-ios-tuntap");
	checks.push({
		id: "appium.tuntap",
		title: "appium-ios-tuntap native module built",
		severity: tuntap.ok ? "ok" : "blocked",
		detail: tuntap.ok ? `importable from ${APPIUM_HOME}` : tuntap.detail,
		autoFixable: !tuntap.ok,
		humanAction: tuntap.ok
			? undefined
			: `cd ${APPIUM_HOME} && npm install-scripts approve appium-ios-tuntap && npm rebuild appium-ios-tuntap`,
	});

	const { reachable, registry } = await readTunnelRegistry(port);
	const hasTunnel = tunnelFor(registry, device.udid);
	const tunnelCommand =
		`sudo env APPIUM_HOME="${APPIUM_HOME}" $(command -v appium) driver run xcuitest tunnel-creation --udid ${device.udid}`;
	checks.push({
		id: "appium.tunnel",
		title: "RemoteXPC tunnel registered for this device",
		severity: hasTunnel ? "ok" : "blocked",
		detail: !reachable
			? `no tunnel registry listening on 127.0.0.1:${port}`
			: hasTunnel
				? `registry lists a tunnel for ${device.udid}`
				: `registry is up (${registry?.metadata?.totalTunnels ?? 0} tunnels) but has no entry for ${device.udid}`,
		// Deliberately not auto-fixable: the driver's own script calls assertRoot().
		// lazy-ios never invokes sudo or handles a password.
		humanAction: hasTunnel
			? undefined
			: `Run this in a terminal and leave it running:\n  ${tunnelCommand}\n(Root is required by the driver's tunnel-creation script; lazy-ios will not run sudo for you. Port ${port} is Appium's registry — pymobiledevice3 tunneld on 49151 is a different thing and will not work.)`,
	});

	// A server that already cached "remotexpc unavailable" keeps failing after
	// the package lands. Compare install time against server start time.
	const packageTime = installedAt("appium-ios-remotexpc");
	const servers = await listAppiumServers();
	const stale = servers.filter((server) => packageTime > 0 && server.startedAt < packageTime);
	checks.push({
		id: "appium.serverFreshness",
		title: "Appium servers started after remotexpc install",
		severity: stale.length > 0 ? "warn" : "ok",
		detail:
			servers.length === 0
				? "no Appium server running (lazy-ios starts its own)"
				: stale.length === 0
					? `${servers.length} server(s), all newer than the remotexpc install`
					: `stale server(s) that will keep failing: ${stale.map((s) => `pid ${s.pid} port ${s.port ?? "?"}`).join(", ")}`,
		autoFixable: stale.length > 0,
		humanAction: stale.length > 0 ? `kill ${stale.map((s) => s.pid).join(" ")}   # restart them after the install` : undefined,
	});

	const ready = checks.every((check) => check.severity !== "blocked");
	return {
		device,
		checks,
		ready,
		humanActions: checks.filter((c) => c.severity === "blocked" && c.humanAction).map((c) => c.humanAction!),
	};
}

export interface AppiumProcess {
	pid: number;
	port?: number;
	startedAt: number;
	command: string;
}

/** Every `appium` server process on the machine, with its start time. */
export async function listAppiumServers(): Promise<AppiumProcess[]> {
	const listed = await run(["/bin/ps", "-Ao", "pid=,lstart=,command="], { timeout: 15_000 });
	const servers: AppiumProcess[] = [];
	for (const line of listed.stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
		if (!match) continue;
		const [, pidText, startText, command] = match;
		if (!command || !/\bappium\b/.test(command) || /appium-mcp|lazy-ios/.test(command)) continue;
		if (!/node|bun/.test(command)) continue;
		const port = /--port[= ](\d+)/.exec(command);
		servers.push({
			pid: Number.parseInt(pidText!, 10),
			port: port ? Number.parseInt(port[1]!, 10) : undefined,
			startedAt: Date.parse(startText!),
			command: command.slice(0, 200),
		});
	}
	return servers;
}

export interface SignedWda {
	path: string;
	version: string;
	profileUuid: string;
}

/**
 * Signed WDA IPAs left by `appium_prepare_ios_real_device`, newest first.
 * lazy-ios reuses those artifacts rather than re-implementing the signing
 * pipeline, but it never assumes one exists.
 */
export function findSignedWda(): SignedWda[] {
	const root = join(homedir(), ".cache", "appium-mcp", "wda-real");
	if (!existsSync(root)) return [];
	const found: SignedWda[] = [];
	const glob = new Bun.Glob("*/signed/*/Payload-resigned.ipa");
	for (const relative of glob.scanSync({ cwd: root, onlyFiles: true, absolute: false })) {
		const [version, , profileUuid] = relative.split("/");
		found.push({ path: join(root, relative), version: version ?? "unknown", profileUuid: profileUuid ?? "unknown" });
	}
	return found.sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs);
}

/** Bundle ids installed on the device, used to confirm WDA is present. */
export async function listInstalledApps(coreDeviceId: string): Promise<string[]> {
	const out = join(process.env.TMPDIR ?? "/tmp", `lazy-ios-apps-${process.pid}.json`);
	const result = await run(
		["xcrun", "devicectl", "device", "info", "apps", "--device", coreDeviceId, "--json-output", out],
		{ timeout: 120_000 },
	);
	if (result.code !== 0) return [];
	try {
		const dump = JSON.parse(await Bun.file(out).text()) as {
			result?: { apps?: Array<{ bundleIdentifier?: string }> };
		};
		return (dump.result?.apps ?? []).map((app) => app.bundleIdentifier ?? "").filter(Boolean);
	} catch {
		return [];
	}
}

export async function xcodeSigningTeams(): Promise<string[]> {
	const result = await run(["security", "find-identity", "-v", "-p", "codesigning"], { timeout: 15_000 });
	const teams = new Set<string>();
	for (const match of result.stdout.matchAll(/\(([A-Z0-9]{10})\)/g)) teams.add(match[1]!);
	return [...teams];
}

/**
 * Launch an installed app on a physical device.
 *
 * Deliberately single-shot: a launch is an external side effect, so a failure
 * whose cause we cannot read (timeout, unparseable output) is reported rather
 * than retried — a second launch would relaunch an app that may already be
 * running and reset whatever state the caller was about to inspect.
 */
export async function devicectlLaunch(coreDeviceId: string, bundleId: string): Promise<{ pid?: number }> {
	const out = join(process.env.TMPDIR ?? "/tmp", `lazy-ios-launch-${process.pid}.json`);
	const result = await run(
		["xcrun", "devicectl", "device", "process", "launch", "--device", coreDeviceId, "--json-output", out, bundleId],
		{ timeout: 180_000 },
	);
	if (result.code !== 0) {
		throw new Error(
			`devicectl launch ${bundleId} failed (exit ${result.code}${result.timedOut ? ", timed out" : ""}): ${(
				result.stderr || result.stdout
			)
				.trim()
				.slice(0, 500)}`,
		);
	}
	try {
		const dump = JSON.parse(await Bun.file(out).text()) as {
			result?: { process?: { processIdentifier?: number } };
		};
		const pid = dump.result?.process?.processIdentifier;
		return pid === undefined ? {} : { pid };
	} catch {
		// Exit 0 means the launch happened; we just cannot report the pid.
		return {};
	}
}
