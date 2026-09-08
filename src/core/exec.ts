/**
 * Process execution primitives.
 *
 * Every external command in lazy-ios goes through here so that three
 * invariants hold everywhere: a deadline is always set, output is always
 * captured (never inherited into the MCP stdio channel, which would corrupt
 * the JSON-RPC stream), and failures carry the command line that produced
 * them.
 */

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	/** Wall time in milliseconds. */
	ms: number;
	/** True when the deadline fired and the child was killed. */
	timedOut: boolean;
	argv: readonly string[];
}

export interface RunOptions {
	/** Milliseconds before SIGKILL. Default 60_000. */
	timeout?: number;
	cwd?: string;
	env?: Record<string, string>;
	/** Text fed to stdin, then stdin is closed. */
	stdin?: string;
	/** Cap captured stdout/stderr so a runaway build log cannot exhaust memory. */
	maxOutput?: number;
}

const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * Process-group leaders spawned by `run` that have not exited.
 *
 * `detached: true` buys a reliable timeout kill, but it also means these
 * children no longer die with the parent's process group. Tracking them lets
 * `killChildren` finish the job on an orderly shutdown.
 */
const liveGroups = new Set<number>();

/** SIGKILL a child's whole process group, falling back to the child alone. */
function killGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already reaped.
		}
	}
}

/**
 * Kill every still-running child group. Called from the shutdown path so an
 * interrupted build does not leave `xcodebuild` and its compiler processes
 * behind — the leak this project exists to remove.
 */
export function killChildren(): number {
	const count = liveGroups.size;
	for (const pid of liveGroups) killGroup(pid);
	liveGroups.clear();
	return count;
}

export class CommandError extends Error {
	constructor(
		message: string,
		readonly result: RunResult,
	) {
		super(message);
		this.name = "CommandError";
	}
}

function clamp(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = text.slice(0, Math.floor(max * 0.25));
	const tail = text.slice(-Math.floor(max * 0.75));
	return `${head}\n…[${text.length - max} chars elided]…\n${tail}`;
}

export async function run(argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
	const timeout = options.timeout ?? DEFAULT_TIMEOUT;
	const maxOutput = options.maxOutput ?? DEFAULT_MAX_OUTPUT;
	const started = Date.now();

	const proc = Bun.spawn(argv as string[], {
		cwd: options.cwd,
		env: options.env ? { ...process.env, ...options.env } : process.env,
		stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
		stdout: "pipe",
		stderr: "pipe",
		// setsid: makes the child a process-group leader so the timeout below can
		// reach its descendants. `xcodebuild` alone spawns swift-frontend, ld,
		// simulator helpers and an XCBBuildService; killing only the direct child
		// leaves those running and recreates the process leak this tool exists to
		// fix. The child is still awaited here — this is not backgrounding.
		detached: true,
	});

	liveGroups.add(proc.pid);
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		killGroup(proc.pid);
	}, timeout);

	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return {
			code,
			stdout: clamp(stdout, maxOutput),
			stderr: clamp(stderr, maxOutput),
			ms: Date.now() - started,
			timedOut,
			argv,
		};
	} finally {
		clearTimeout(timer);
		// Untrack before the pid can be recycled. A stale entry would make
		// `killChildren` signal whatever process later inherits this pid.
		liveGroups.delete(proc.pid);
	}
}

/** Run and throw unless the exit code is 0. */
export async function runOk(argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
	const result = await run(argv, options);
	if (result.code !== 0) {
		const why = result.timedOut ? `timed out after ${options.timeout ?? DEFAULT_TIMEOUT}ms` : `exit ${result.code}`;
		throw new CommandError(
			`${argv[0]} ${why}: ${(result.stderr || result.stdout).trim().slice(0, 800)}`,
			result,
		);
	}
	return result;
}

/** Run, parse stdout as JSON, throw on non-zero exit or unparseable output. */
export async function runJson<T>(argv: readonly string[], options: RunOptions = {}): Promise<T> {
	const result = await runOk(argv, options);
	try {
		return JSON.parse(result.stdout) as T;
	} catch (error) {
		throw new CommandError(
			`${argv[0]} did not return JSON: ${(error as Error).message}`,
			result,
		);
	}
}

/** True when the binary resolves on PATH. */
export async function which(binary: string): Promise<string | null> {
	const result = await run(["/usr/bin/which", binary], { timeout: 5_000 });
	const path = result.stdout.trim();
	return result.code === 0 && path.length > 0 ? path : null;
}

/**
 * Poll until `probe` returns a non-null value or the budget is exhausted.
 * Returns null on timeout — callers decide whether that is fatal.
 */
export async function waitFor<T>(
	probe: () => Promise<T | null>,
	options: { timeout: number; interval?: number },
): Promise<T | null> {
	const interval = options.interval ?? 500;
	const deadline = Date.now() + options.timeout;
	for (;;) {
		const value = await probe();
		if (value !== null) return value;
		if (Date.now() >= deadline) return null;
		await Bun.sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
	}
}
