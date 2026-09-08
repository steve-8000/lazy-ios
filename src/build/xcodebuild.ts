/**
 * xcodebuild wrapper.
 *
 * lazy-ios drives `xcodebuild` directly rather than proxying Xcode's own MCP
 * bridge (`xcrun mcpbridge`), because that bridge forwards to a *running*
 * Xcode.app instance: it needs the GUI open on the right project and cannot be
 * relied on from a headless automation run.
 *
 * The build result the caller needs is not "exit 0" but "here is the .app and
 * here is its bundle id", so every build resolves the product path from
 * `-showBuildSettings` instead of guessing at DerivedData layout.
 */

import { existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { run, runJson, type RunResult } from "../core/exec.ts";
import { LAZY_HOME } from "../core/ledger.ts";

export type ProjectKind = "workspace" | "project" | "package";

export interface ProjectRef {
	kind: ProjectKind;
	/** Absolute path to the .xcworkspace / .xcodeproj / package directory. */
	path: string;
	name: string;
}

export interface SchemeInfo {
	schemes: string[];
	configurations: string[];
	targets: string[];
}

/** Find the buildable thing at `dir`, preferring a workspace over a project. */
export function discoverProject(dir: string): ProjectRef | null {
	const root = resolve(dir);
	const workspaces = [...new Bun.Glob("*.xcworkspace").scanSync({ cwd: root, onlyFiles: false })]
		// Xcode drops a workspace inside every .xcodeproj; that one is not a target.
		.filter((entry) => !entry.includes(".xcodeproj"));
	if (workspaces[0]) {
		const path = join(root, workspaces[0]);
		return { kind: "workspace", path, name: basename(path, ".xcworkspace") };
	}
	const projects = [...new Bun.Glob("*.xcodeproj").scanSync({ cwd: root, onlyFiles: false })];
	if (projects[0]) {
		const path = join(root, projects[0]);
		return { kind: "project", path, name: basename(path, ".xcodeproj") };
	}
	if (existsSync(join(root, "Package.swift"))) {
		return { kind: "package", path: root, name: basename(root) };
	}
	return null;
}

function containerArgs(project: ProjectRef): string[] {
	switch (project.kind) {
		case "workspace":
			return ["-workspace", project.path];
		case "project":
			return ["-project", project.path];
		case "package":
			return [];
	}
}

export async function listSchemes(project: ProjectRef): Promise<SchemeInfo> {
	const listed = await runJson<{
		workspace?: { schemes?: string[] };
		project?: { schemes?: string[]; configurations?: string[]; targets?: string[] };
	}>(["xcodebuild", "-list", "-json", ...containerArgs(project)], {
		timeout: 180_000,
		cwd: project.kind === "package" ? project.path : undefined,
	});
	return {
		schemes: listed.workspace?.schemes ?? listed.project?.schemes ?? [],
		configurations: listed.project?.configurations ?? [],
		targets: listed.project?.targets ?? [],
	};
}

export interface BuildSettings {
	productName: string;
	fullProductName: string;
	bundleId: string;
	targetBuildDir: string;
	appPath: string;
	sdk: string;
}

export async function buildSettings(
	project: ProjectRef,
	scheme: string,
	destination: string,
	configuration: string,
	derivedDataPath: string,
): Promise<BuildSettings | null> {
	const dumped = await run(
		[
			"xcodebuild",
			...containerArgs(project),
			"-scheme",
			scheme,
			"-configuration",
			configuration,
			"-destination",
			destination,
			"-derivedDataPath",
			derivedDataPath,
			"-showBuildSettings",
			"-json",
		],
		{ timeout: 300_000, cwd: project.kind === "package" ? project.path : undefined },
	);
	if (dumped.code !== 0) return null;
	let entries: Array<{ target?: string; buildSettings?: Record<string, string> }>;
	try {
		entries = JSON.parse(dumped.stdout) as Array<{ target?: string; buildSettings?: Record<string, string> }>;
	} catch {
		return null;
	}
	// The app target is the one that produces a .app wrapper.
	for (const entry of entries) {
		const settings = entry.buildSettings;
		if (!settings) continue;
		const fullProductName = settings.FULL_PRODUCT_NAME ?? "";
		if (!fullProductName.endsWith(".app")) continue;
		const targetBuildDir = settings.TARGET_BUILD_DIR ?? "";
		return {
			productName: settings.PRODUCT_NAME ?? entry.target ?? scheme,
			fullProductName,
			bundleId: settings.PRODUCT_BUNDLE_IDENTIFIER ?? "",
			targetBuildDir,
			appPath: join(targetBuildDir, fullProductName),
			sdk: settings.SDK_NAME ?? "",
		};
	}
	return null;
}

export interface BuildIssue {
	kind: "error" | "warning";
	file?: string;
	line?: number;
	message: string;
}

/**
 * Pull compiler diagnostics out of an xcodebuild log.
 *
 * A failed build log is tens of thousands of lines; the caller needs the ten
 * that say what is wrong. Deduplicated because xcodebuild repeats the same
 * diagnostic once per target pass.
 */
export function parseIssues(log: string, limit = 40): BuildIssue[] {
	const issues: BuildIssue[] = [];
	const seen = new Set<string>();
	const located = /^(\/[^\s:]+):(\d+):(?:(\d+):)?\s+(error|warning):\s+(.*)$/;
	const bare = /^(?:.*\s)?(error|warning):\s+(.*)$/;
	for (const line of log.split("\n")) {
		const hit = located.exec(line);
		if (hit) {
			const key = `${hit[1]}:${hit[2]}:${hit[5]}`;
			if (seen.has(key)) continue;
			seen.add(key);
			issues.push({
				kind: hit[4] === "error" ? "error" : "warning",
				file: hit[1],
				line: Number.parseInt(hit[2]!, 10),
				message: hit[5]!.trim(),
			});
		} else {
			const loose = bare.exec(line);
			if (!loose) continue;
			const message = loose[2]!.trim();
			if (!message || seen.has(message)) continue;
			seen.add(message);
			issues.push({ kind: loose[1] === "error" ? "error" : "warning", message });
		}
		if (issues.length >= limit) break;
	}
	// Errors first: a truncated list must not be all warnings.
	return issues.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "error" ? -1 : 1));
}

export interface BuildRequest {
	project: ProjectRef;
	scheme: string;
	/** `id=<udid>` for a specific device, or a generic destination string. */
	destination: string;
	configuration?: string;
	derivedDataPath?: string;
	/** Simulator builds skip signing entirely; device builds must not. */
	forSimulator: boolean;
	developmentTeam?: string;
	allowProvisioningUpdates?: boolean;
	extraArgs?: readonly string[];
	timeout?: number;
}

export interface BuildOutcome {
	ok: boolean;
	durationMs: number;
	appPath?: string;
	bundleId?: string;
	issues: BuildIssue[];
	logPath: string;
	command: string;
	/** Last lines of the log, so a failure is legible without opening the file. */
	tail: string;
}

export function derivedDataFor(project: ProjectRef): string {
	return join(LAZY_HOME, "derived", `${project.name}-${Bun.hash(project.path).toString(16)}`);
}

/**
 * The directories a build writes into.
 *
 * Created here rather than relying on another module's import side effect:
 * `xcodebuild -resultBundlePath` fails outright if the parent is missing, and
 * a successful build whose log write throws reports as a failure.
 */
function ensureOutputDirs(): void {
	for (const directory of ["logs", "results", "derived"]) {
		mkdirSync(join(LAZY_HOME, directory), { recursive: true });
	}
}

export async function build(request: BuildRequest): Promise<BuildOutcome> {
	ensureOutputDirs();
	const configuration = request.configuration ?? "Debug";
	const derivedDataPath = request.derivedDataPath ?? derivedDataFor(request.project);
	const argv = [
		"xcodebuild",
		...containerArgs(request.project),
		"-scheme",
		request.scheme,
		"-configuration",
		configuration,
		"-destination",
		request.destination,
		"-derivedDataPath",
		derivedDataPath,
		"build",
	];
	if (request.forSimulator) {
		// Signing a simulator build buys nothing and fails on machines whose
		// certificates do not cover the scheme's bundle id.
		argv.push("CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", "CODE_SIGN_IDENTITY=");
	} else {
		// Command-line settings outrank the project file, and they have to:
		// a project carrying `CODE_SIGNING_ALLOWED=NO` (normal for something
		// only ever run on a simulator) otherwise builds a valid-looking
		// unsigned .app, and the failure surfaces much later as an opaque
		// `ApplicationVerificationFailed` from the device at install time.
		argv.push("CODE_SIGNING_ALLOWED=YES", "CODE_SIGNING_REQUIRED=YES", "CODE_SIGN_STYLE=Automatic");
		if (request.developmentTeam) argv.push(`DEVELOPMENT_TEAM=${request.developmentTeam}`);
		if (request.allowProvisioningUpdates !== false) argv.push("-allowProvisioningUpdates");
	}
	argv.push(...(request.extraArgs ?? []));

	const started = Date.now();
	const result = await run(argv, {
		timeout: request.timeout ?? 1_800_000,
		cwd: request.project.kind === "package" ? request.project.path : undefined,
	});
	const log = `${result.stdout}\n${result.stderr}`;
	const logPath = join(LAZY_HOME, "logs", `build-${Date.now()}.log`);
	await Bun.write(logPath, `$ ${argv.join(" ")}\n\n${log}`);

	const settings = result.code === 0
		? await buildSettings(request.project, request.scheme, request.destination, configuration, derivedDataPath)
		: null;

	return {
		ok: result.code === 0,
		durationMs: Date.now() - started,
		appPath: settings?.appPath && existsSync(settings.appPath) ? settings.appPath : undefined,
		bundleId: settings?.bundleId || undefined,
		issues: parseIssues(log),
		logPath,
		command: argv.join(" "),
		tail: log.trimEnd().split("\n").slice(-25).join("\n"),
	};
}

export interface TestRequest extends BuildRequest {
	/** Restrict to `Target/Class/method` identifiers. */
	only?: readonly string[];
	resultBundlePath?: string;
}

export interface TestSummary {
	ok: boolean;
	durationMs: number;
	total: number;
	passed: number;
	failed: number;
	skipped: number;
	failures: Array<{ test: string; message: string }>;
	resultBundlePath: string;
	logPath: string;
	tail: string;
}

interface XcTestSummary {
	result?: string;
	totalTestCount?: number;
	passedTests?: number;
	failedTests?: number;
	skippedTests?: number;
	testFailures?: Array<{ testName?: string; targetName?: string; failureText?: string }>;
}

export async function test(request: TestRequest): Promise<TestSummary> {
	ensureOutputDirs();
	const configuration = request.configuration ?? "Debug";
	const derivedDataPath = request.derivedDataPath ?? derivedDataFor(request.project);
	const resultBundlePath = request.resultBundlePath ?? join(LAZY_HOME, "results", `test-${Date.now()}.xcresult`);
	const argv = [
		"xcodebuild",
		...containerArgs(request.project),
		"-scheme",
		request.scheme,
		"-configuration",
		configuration,
		"-destination",
		request.destination,
		"-derivedDataPath",
		derivedDataPath,
		"-resultBundlePath",
		resultBundlePath,
		"test",
	];
	for (const only of request.only ?? []) argv.push("-only-testing", only);
	if (request.forSimulator) argv.push("CODE_SIGNING_ALLOWED=NO");
	else if (request.developmentTeam) argv.push(`DEVELOPMENT_TEAM=${request.developmentTeam}`, "-allowProvisioningUpdates");
	argv.push(...(request.extraArgs ?? []));

	const started = Date.now();
	const result: RunResult = await run(argv, {
		timeout: request.timeout ?? 3_600_000,
		cwd: request.project.kind === "package" ? request.project.path : undefined,
	});
	const log = `${result.stdout}\n${result.stderr}`;
	const logPath = join(LAZY_HOME, "logs", `test-${Date.now()}.log`);
	await Bun.write(logPath, `$ ${argv.join(" ")}\n\n${log}`);

	let summary: XcTestSummary = {};
	if (existsSync(resultBundlePath)) {
		const dumped = await run(
			["xcrun", "xcresulttool", "get", "test-results", "summary", "--path", resultBundlePath, "--compact"],
			{ timeout: 180_000 },
		);
		if (dumped.code === 0) {
			try {
				summary = JSON.parse(dumped.stdout) as XcTestSummary;
			} catch {
				summary = {};
			}
		}
	}

	return {
		ok: result.code === 0,
		durationMs: Date.now() - started,
		total: summary.totalTestCount ?? 0,
		passed: summary.passedTests ?? 0,
		failed: summary.failedTests ?? 0,
		skipped: summary.skippedTests ?? 0,
		failures: (summary.testFailures ?? []).map((failure) => ({
			test: [failure.targetName, failure.testName].filter(Boolean).join("/") || "unknown",
			message: (failure.failureText ?? "").split("\n")[0] ?? "",
		})),
		resultBundlePath,
		logPath,
		tail: log.trimEnd().split("\n").slice(-25).join("\n"),
	};
}
