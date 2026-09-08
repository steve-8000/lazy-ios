/**
 * `ios_run` — the lazy path from a source directory to signed-off evidence.
 *
 * discover → build → acquire target → install → launch → wait for AX →
 * scripted steps → screenshot + AX evidence → release.
 *
 * The release step is unconditional. A run that throws halfway still gives the
 * simulator back, because the failure mode this project exists to remove is
 * "the automation worked but left five booted devices behind".
 */

import { join } from "node:path";

import { waitFor } from "./core/exec.ts";
import {
	type BuildOutcome,
	type ProjectRef,
	type TestSummary,
	build,
	discoverProject,
	listSchemes,
	test as runTests,
} from "./build/xcodebuild.ts";
import { devicectlLaunch } from "./ios/device.ts";
import { installApp, launchApp, terminateApp } from "./ios/simulator.ts";
import { installOnDevice, activateApp } from "./ios/appium.ts";
import { type Session, closeSession, openSession } from "./session.ts";
import { type UiSnapshot, centerOf, evidencePath, findNode } from "./ui/driver.ts";

export type Step =
	| { tap: string }
	| { tapAt: { x: number; y: number } }
	| { text: string }
	| { swipe: { fromX: number; fromY: number; toX: number; toY: number; duration?: number } }
	| { wait: number }
	| { shot: string }
	| { expect: string }
	| { home: true };

export interface PhaseResult {
	phase: string;
	ok: boolean;
	ms: number;
	detail: string;
}

export interface RunRequest {
	/** Directory holding the .xcworkspace/.xcodeproj. Defaults to cwd. */
	path?: string;
	scheme?: string;
	configuration?: string;
	target?: "simulator" | "device" | "auto";
	udid?: string;
	runtime?: string;
	deviceType?: string;
	bundleId?: string;
	steps?: Step[];
	/** Run the scheme's tests instead of a UI smoke pass. */
	test?: boolean;
	only?: string[];
	/** Leave the session open for follow-up `ios_ui` calls. */
	keepOpen?: boolean;
	/** Delete the scratch simulator on teardown instead of keeping it warm. */
	destroy?: boolean;
	developmentTeam?: string;
}

export interface RunReport {
	ok: boolean;
	target: { kind: string; udid: string; name: string; runtime: string };
	project?: { path: string; kind: string; scheme: string };
	phases: PhaseResult[];
	build?: BuildOutcome;
	tests?: TestSummary;
	evidence: string[];
	sessionId?: string;
	/** Populated when a step's `expect` was not satisfied. */
	failures: string[];
}

/**
 * Stop the pipeline without unwinding past teardown.
 *
 * The phase that failed already recorded *why* in `phases`, so this carries no
 * message: it exists purely so every exit path reaches the same finalisation
 * and the same release step.
 */
class Halt extends Error {}

async function timed(phase: string, work: () => Promise<string>): Promise<PhaseResult> {
	const started = Date.now();
	try {
		const detail = await work();
		return { phase, ok: true, ms: Date.now() - started, detail };
	} catch (error) {
		return { phase, ok: false, ms: Date.now() - started, detail: (error as Error).message };
	}
}

/**
 * Wait until the accessibility tree is populated.
 *
 * A device's first boot can answer "no accessibility data" for ~40 s after the
 * app is already running, so this retries rather than concluding the launch
 * failed.
 */
async function settle(session: Session, timeout = 90_000): Promise<UiSnapshot | null> {
	return await waitFor(
		async () => {
			try {
				const snapshot = await session.driver.describe();
				return snapshot.nodeCount > 1 ? snapshot : null;
			} catch {
				return null;
			}
		},
		{ timeout, interval: 1_500 },
	);
}

export async function runLazy(request: RunRequest): Promise<RunReport> {
	const phases: PhaseResult[] = [];
	const evidence: string[] = [];
	const failures: string[] = [];
	let session: Session | undefined;
	let buildOutcome: BuildOutcome | undefined;
	let testSummary: TestSummary | undefined;
	let project: ProjectRef | null = null;
	let scheme = request.scheme ?? "";
	// Filled in by whichever exit the pipeline takes; `ok` is decided at the
	// very end, after teardown, so that every path reports the same shape.
	let report: RunReport = {
		ok: false,
		target: { kind: "none", udid: "", name: "", runtime: "" },
		phases,
		evidence,
		failures,
	};

	try {
		// ── discover ──
		const root = request.path ?? process.cwd();
		phases.push(
			await timed("discover", async () => {
				project = discoverProject(root);
				if (!project) throw new Error(`no .xcworkspace, .xcodeproj or Package.swift under ${root}`);
				if (!scheme) {
					const listed = await listSchemes(project);
					scheme = listed.schemes[0] ?? "";
					if (!scheme) throw new Error(`no schemes in ${project.path}`);
				}
				return `${project.kind} ${project.path} scheme=${scheme}`;
			}),
		);
		if (!phases.at(-1)!.ok || !project) throw new Halt();
		const resolvedProject: ProjectRef = project;

		// ── target ──
		const wantDevice = request.target === "device";
		phases.push(
			await timed("target", async () => {
				session = await openSession(
					wantDevice
						? { kind: "device", udid: request.udid, bundleId: request.bundleId, purpose: `ios_run ${scheme}` }
						: {
								kind: "simulator",
								udid: request.udid,
								runtime: request.runtime,
								deviceType: request.deviceType,
								purpose: `ios_run ${scheme}`,
							},
				);
				const how = session.simulator ? session.simulator.disposition : "attached";
				return `${session.kind} ${session.name} (${session.runtime}) ${how} udid=${session.udid}`;
			}),
		);
		if (!session) throw new Halt();
		const activeSession: Session = session;

		// ── build ──
		const destination = `id=${activeSession.udid}`;
		if (request.test) {
			phases.push(
				await timed("test", async () => {
					testSummary = await runTests({
						project: resolvedProject,
						scheme,
						destination,
						configuration: request.configuration,
						forSimulator: activeSession.kind === "simulator",
						developmentTeam: request.developmentTeam,
						only: request.only,
					});
					if (!testSummary.ok) {
						throw new Error(
							`${testSummary.failed}/${testSummary.total} failed: ${testSummary.failures
								.slice(0, 5)
								.map((failure) => `${failure.test} — ${failure.message}`)
								.join(" | ")}`,
						);
					}
					return `${testSummary.passed}/${testSummary.total} passed in ${Math.round(testSummary.durationMs / 1000)}s`;
				}),
			);
		} else {
			phases.push(
				await timed("build", async () => {
					buildOutcome = await build({
						project: resolvedProject,
						scheme,
						destination,
						configuration: request.configuration,
						forSimulator: activeSession.kind === "simulator",
						developmentTeam: request.developmentTeam,
					});
					if (!buildOutcome.ok) {
						const errors = buildOutcome.issues.filter((issue) => issue.kind === "error").slice(0, 5);
						throw new Error(
							errors.length > 0
								? errors.map((issue) => `${issue.file ?? ""}${issue.line ? `:${issue.line}` : ""} ${issue.message}`).join(" | ")
								: `xcodebuild failed; log: ${buildOutcome.logPath}`,
						);
					}
					if (!buildOutcome.appPath) throw new Error(`build succeeded but produced no .app (log: ${buildOutcome.logPath})`);
					return `${buildOutcome.appPath} (${buildOutcome.bundleId ?? "unknown bundle id"}) in ${Math.round(buildOutcome.durationMs / 1000)}s`;
				}),
			);

			const bundleId = request.bundleId ?? buildOutcome?.bundleId;

			// ── install + launch ──
			if (phases.at(-1)!.ok && buildOutcome?.appPath && bundleId) {
				const appPath = buildOutcome.appPath;
				phases.push(
					await timed("install", async () => {
						if (activeSession.kind === "simulator") {
							await installApp(activeSession.udid, appPath);
							return `installed ${bundleId} on ${activeSession.name}`;
						}
						if (!activeSession.webdriver) throw new Error("device session has no WebDriver session");
						await installOnDevice(activeSession.webdriver, appPath);
						return `installed ${bundleId} on ${activeSession.name}`;
					}),
				);
				phases.push(
					await timed("launch", async () => {
						activeSession.bundleId = bundleId;
						if (activeSession.kind === "simulator") {
							const pid = await launchApp(activeSession.udid, bundleId, { relaunch: true });
							return `launched ${bundleId} pid=${pid}`;
						}
						if (activeSession.webdriver) {
							await activateApp(activeSession.webdriver, bundleId);
							return `activated ${bundleId}`;
						}
						const launched = await devicectlLaunch(activeSession.device?.coreDeviceId ?? "", bundleId);
						return `launched ${bundleId}${launched.pid ? ` pid=${launched.pid}` : ""}`;
					}),
				);
			}
		}

		// ── settle + steps + evidence ──
		if (!request.test && phases.every((phase) => phase.ok)) {
			phases.push(
				await timed("settle", async () => {
					const snapshot = await settle(activeSession);
					if (!snapshot) throw new Error("accessibility tree stayed empty — app may not be frontmost");
					const before = evidencePath("ax-before", "json");
					await Bun.write(before, JSON.stringify(snapshot, null, 2));
					evidence.push(before);
					return `${snapshot.nodeCount} AX nodes, screen ${snapshot.screen.width}x${snapshot.screen.height}pt`;
				}),
			);

			for (const [index, step] of (request.steps ?? []).entries()) {
				phases.push(
					await timed(`step${index + 1}`, async () => await applyStep(activeSession, step, evidence, failures)),
				);
			}

			phases.push(
				await timed("evidence", async () => {
					const shot = evidencePath("screen", "png");
					await activeSession.driver.screenshot(shot);
					evidence.push(shot);
					const snapshot = await activeSession.driver.describe();
					const after = evidencePath("ax-after", "json");
					await Bun.write(after, JSON.stringify(snapshot, null, 2));
					evidence.push(after);
					return `screenshot + ${snapshot.nodeCount}-node AX tree`;
				}),
			);
		}

		report = {
			ok: false,
			target: {
				kind: activeSession.kind,
				udid: activeSession.udid,
				name: activeSession.name,
				runtime: activeSession.runtime,
			},
			project: { path: resolvedProject.path, kind: resolvedProject.kind, scheme },
			phases,
			build: buildOutcome,
			tests: testSummary,
			evidence,
			sessionId: request.keepOpen ? activeSession.id : undefined,
			failures,
		};
	} catch (error) {
		// A Halt means the failing phase already explained itself. Anything else
		// is a bug in the pipeline and must still be reported, not swallowed by
		// unwinding past the report.
		if (!(error instanceof Halt)) {
			phases.push({ phase: "unexpected", ok: false, ms: 0, detail: (error as Error).message });
		}
	} finally {
		// Unconditional: this is the anti-leak guarantee. It runs before the
		// report's `ok` is computed, so a failed release fails the run — a run
		// that leaves a device behind did not succeed.
		if (session && !request.keepOpen) {
			const closing = session;
			phases.push(
				await timed("release", async () => {
					const outcome = await closeSession(closing.id, { destroy: request.destroy });
					return `${outcome.kind} ${outcome.udid.slice(0, 8)} → ${outcome.device}`;
				}),
			);
		}
	}

	report.ok = phases.every((phase) => phase.ok) && failures.length === 0;
	return report;
}

async function applyStep(session: Session, step: Step, evidence: string[], failures: string[]): Promise<string> {
	if ("wait" in step) {
		await Bun.sleep(step.wait);
		return `waited ${step.wait}ms`;
	}
	if ("home" in step) {
		await session.driver.home();
		return "sent home";
	}
	if ("shot" in step) {
		const path = join(evidencePath(`shot-${step.shot.replaceAll(/\W+/g, "-")}`, "png"));
		await session.driver.screenshot(path);
		evidence.push(path);
		return `screenshot ${path}`;
	}
	if ("tapAt" in step) {
		await session.driver.tap(step.tapAt.x, step.tapAt.y);
		return `tapped (${step.tapAt.x}, ${step.tapAt.y})`;
	}
	if ("swipe" in step) {
		await session.driver.swipe(
			{ x: step.swipe.fromX, y: step.swipe.fromY },
			{ x: step.swipe.toX, y: step.swipe.toY },
			step.swipe.duration,
		);
		return `swiped (${step.swipe.fromX},${step.swipe.fromY}) → (${step.swipe.toX},${step.swipe.toY})`;
	}
	if ("text" in step) {
		await session.driver.inputText(step.text);
		return `entered ${step.text.length} chars`;
	}
	if ("tap" in step) {
		const snapshot = await session.driver.describe();
		const node = findNode(snapshot, step.tap);
		if (!node) throw new Error(`no visible element matching "${step.tap}"`);
		const center = centerOf(node);
		await session.driver.tap(center.x, center.y);
		return `tapped "${node.label || node.identifier}" at (${Math.round(center.x)}, ${Math.round(center.y)})`;
	}
	// expect
	const snapshot = await session.driver.describe();
	const node = findNode(snapshot, step.expect);
	if (!node) {
		failures.push(`expected "${step.expect}" on screen, not found among ${snapshot.nodeCount} nodes`);
		throw new Error(`expected "${step.expect}" on screen, not found`);
	}
	return `found "${node.label || node.identifier}"`;
}

export async function terminateSessionApp(session: Session): Promise<void> {
	if (!session.bundleId) return;
	if (session.kind === "simulator") await terminateApp(session.udid, session.bundleId);
}
