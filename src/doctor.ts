/**
 * Environment report.
 *
 * `ios_doctor` answers one question: if a run fails right now, which
 * precondition is the reason? Everything reported is measured, and the fix
 * mode only touches things lazy-ios owns — foreign simulators and foreign
 * Appium servers are reported so a human can act, never reclaimed.
 */

import { run, which } from "./core/exec.ts";
import { type LedgerState, isAlive, ledgerPath, readLedger } from "./core/ledger.ts";
import { stopAppium } from "./ios/appium.ts";
import {
	APPIUM_HOME,
	type Check,
	type PreflightResult,
	listAppiumServers,
	listRealDevices,
	findSignedWda,
	preflightRealDevice,
} from "./ios/device.ts";
import { type ReapReport, foreignBooted, listSimulators, reapSimulators } from "./ios/simulator.ts";

/** baguette below this cannot find SimulatorKit under Xcode 27. */
const BAGUETTE_FLOOR = "0.1.96";

export interface DoctorReport {
	ok: boolean;
	checks: Check[];
	simulators: {
		total: number;
		booted: number;
		ownedByLazyIos: number;
		foreignBooted: Array<{ udid: string; name: string; runtime: string }>;
	};
	realDevices: Array<{ udid: string; name: string; osVersion: string; connected: boolean; developerMode: string }>;
	devicePreflight?: PreflightResult;
	strayProcesses: Array<{ pid: number; kind: string; detail: string }>;
	ledger: { path: string; devices: number; processes: number };
	fixesApplied: string[];
}

function compareVersions(left: string, right: string): number {
	const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
	const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

async function toolChecks(): Promise<Check[]> {
	const checks: Check[] = [];

	const xcodePath = await run(["xcode-select", "-p"], { timeout: 10_000 });
	const xcodeVersion = await run(["xcodebuild", "-version"], { timeout: 30_000 });
	checks.push({
		id: "tool.xcode",
		title: "Xcode command line tools",
		severity: xcodeVersion.code === 0 ? "ok" : "blocked",
		detail:
			xcodeVersion.code === 0
				? `${xcodeVersion.stdout.trim().replaceAll("\n", " · ")} at ${xcodePath.stdout.trim()}`
				: xcodeVersion.stderr.trim().slice(0, 200),
		humanAction: xcodeVersion.code === 0 ? undefined : "sudo xcode-select -s /Applications/Xcode.app",
	});

	const baguettePath = await which("baguette");
	const baguetteVersion = baguettePath ? (await run(["baguette", "--version"], { timeout: 10_000 })).stdout.trim() : "";
	const baguetteOld = baguetteVersion !== "" && compareVersions(baguetteVersion, BAGUETTE_FLOOR) < 0;
	checks.push({
		id: "tool.baguette",
		title: `baguette >= ${BAGUETTE_FLOOR}`,
		severity: !baguettePath ? "blocked" : baguetteOld ? "blocked" : "ok",
		detail: baguettePath ? `${baguetteVersion} at ${baguettePath}` : "not installed",
		// Xcode 27 moved SimulatorKit.framework into Contents/SharedFrameworks;
		// older baguette dies with no fallback.
		humanAction: !baguettePath ? "brew install baguette" : baguetteOld ? "brew upgrade baguette" : undefined,
	});

	const appiumPath = await which("appium");
	const appiumVersion = appiumPath ? (await run(["appium", "--version"], { timeout: 30_000 })).stdout.trim() : "";
	checks.push({
		id: "tool.appium",
		title: "Appium server",
		severity: appiumPath ? "ok" : "warn",
		detail: appiumPath ? `${appiumVersion} at ${appiumPath} (APPIUM_HOME=${APPIUM_HOME})` : "not installed — real-device automation unavailable",
		humanAction: appiumPath ? undefined : "npm install -g appium && appium driver install xcuitest",
	});

	const wda = findSignedWda();
	checks.push({
		id: "tool.signedWda",
		title: "signed WebDriverAgent available",
		severity: wda.length > 0 ? "ok" : "warn",
		detail:
			wda.length > 0
				? `${wda.length} signed IPA(s), newest ${wda[0]!.path} (WDA ${wda[0]!.version}, profile ${wda[0]!.profileUuid})`
				: "no signed WDA IPA cached — device sessions will fall back to an xcodebuild WDA build",
	});

	return checks;
}

export interface DoctorOptions {
	/** Apply the safe, ownership-scoped repairs. */
	fix?: boolean;
	/** Delete reclaimed scratch simulators instead of leaving them shut down. */
	destroyScratch?: boolean;
	/** Include the real-device preflight (slower: talks to CoreDevice). */
	includeDevice?: boolean;
	udid?: string;
}

export async function doctor(options: DoctorOptions = {}): Promise<DoctorReport> {
	const checks = await toolChecks();
	const fixesApplied: string[] = [];

	const ledger: LedgerState = await readLedger();
	const sims = await listSimulators();
	const booted = sims.filter((device) => device.state === "Booted");
	const owned = Object.values(ledger.devices);
	const foreign = await foreignBooted();

	checks.push({
		id: "sim.pressure",
		title: "booted simulator pressure",
		severity: booted.length > 4 ? "warn" : "ok",
		detail: `${sims.length} simulators exist, ${booted.length} booted, ${owned.length} under a lazy-ios lease`,
		humanAction:
			foreign.length > 0
				? `Not owned by lazy-ios, so not touched: ${foreign
						.map((device) => `${device.name} (${device.udid.slice(0, 8)})`)
						.join(", ")}. Shut them down with: xcrun simctl shutdown ${foreign.map((d) => d.udid).join(" ")}`
				: undefined,
	});

	const appiumServers = await listAppiumServers();
	const ledgerAppium = ledger.processes.appium;
	const strayProcesses = appiumServers
		.filter((server) => server.pid !== ledgerAppium?.pid)
		.map((server) => ({
			pid: server.pid,
			kind: "appium-server",
			detail: `port ${server.port ?? "?"} started ${new Date(server.startedAt).toISOString()} — not lazy-ios owned`,
		}));

	const mcpProcesses = await run(["/usr/bin/pgrep", "-f", "appium-mcp"], { timeout: 10_000 });
	for (const line of mcpProcesses.stdout.trim().split("\n").filter(Boolean)) {
		strayProcesses.push({ pid: Number.parseInt(line, 10), kind: "appium-mcp", detail: "legacy appium-mcp process" });
	}
	checks.push({
		id: "process.strays",
		title: "helper processes",
		severity: strayProcesses.length > 2 ? "warn" : "ok",
		detail:
			strayProcesses.length === 0
				? `only the lazy-ios supervised server${ledgerAppium ? ` (pid ${ledgerAppium.pid})` : " (none running)"}`
				: `${strayProcesses.length} process(es) lazy-ios does not own: ${strayProcesses
						.map((process) => `${process.kind}#${process.pid}`)
						.join(", ")}`,
		humanAction:
			strayProcesses.length > 0 ? `kill ${strayProcesses.map((process) => process.pid).join(" ")}` : undefined,
	});

	let reap: ReapReport | null = null;
	if (options.fix) {
		reap = await reapSimulators({ destroyScratch: options.destroyScratch });
		if (reap.released.length > 0 || reap.pruned.length > 0) {
			fixesApplied.push(
				`reclaimed ${reap.released.length} lease(s) (${reap.released
					.map((outcome) => `${outcome.udid.slice(0, 8)}:${outcome.action}`)
					.join(", ")})${reap.pruned.length ? `, pruned ${reap.pruned.length} dead ledger entr(y|ies)` : ""}`,
			);
		}
		if (ledgerAppium && !isAlive(ledgerAppium.pid)) {
			await stopAppium();
			fixesApplied.push(`cleared dead Appium record (pid ${ledgerAppium.pid})`);
		}
	}

	const realDevices = await listRealDevices();
	let devicePreflight: PreflightResult | undefined;
	if (options.includeDevice !== false && realDevices.length > 0) {
		devicePreflight = await preflightRealDevice({ udid: options.udid });
		checks.push(...devicePreflight.checks);
	}

	const after = options.fix ? await readLedger() : ledger;
	return {
		ok: checks.every((check) => check.severity !== "blocked"),
		checks,
		simulators: {
			total: sims.length,
			booted: booted.length,
			ownedByLazyIos: owned.length,
			foreignBooted: foreign.map((device) => ({ udid: device.udid, name: device.name, runtime: device.runtime })),
		},
		realDevices: realDevices.map((device) => ({
			udid: device.udid,
			name: device.name,
			osVersion: device.osVersion,
			connected: device.connected,
			developerMode: device.developerMode,
		})),
		devicePreflight,
		strayProcesses,
		ledger: {
			path: ledgerPath,
			devices: Object.keys(after.devices).length,
			processes: Object.keys(after.processes).length,
		},
		fixesApplied,
	};
}
