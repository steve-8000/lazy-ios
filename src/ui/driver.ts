/**
 * One UI vocabulary over two very different backends.
 *
 * Simulator  → `baguette`, which talks to Apple's private SimulatorHID. No
 *              WebDriverAgent, no signing, no tunnel; it is the fast path and
 *              it is the only one that works on a plain scratch device.
 * Real device → WebDriverAgent through Appium, because nothing else can reach
 *              a physical phone's accessibility layer.
 *
 * The normalised `UiNode` is what makes `ios_ui` and the smoke flow identical
 * on both. Frames are always in **points**, matching what taps expect;
 * screenshots are pixels and are never mixed into coordinates.
 */

import { join } from "node:path";

import { run, runOk } from "../core/exec.ts";
import { LAZY_HOME } from "../core/ledger.ts";
import {
	type WebDriverSession,
	execute,
	pageSource,
	pointerActions,
	screenshotBase64,
	windowRect,
} from "../ios/appium.ts";

export interface UiNode {
	role: string;
	label: string;
	identifier: string;
	value: string;
	frame: { x: number; y: number; width: number; height: number };
	enabled: boolean;
	visible: boolean;
	children: UiNode[];
}

export interface UiSnapshot {
	/** Root frame in points — the coordinate space taps must use. */
	screen: { width: number; height: number };
	root: UiNode;
	nodeCount: number;
}

export interface UiDriver {
	readonly kind: "simulator" | "device";
	readonly target: string;
	describe(): Promise<UiSnapshot>;
	screenshot(path: string): Promise<string>;
	tap(x: number, y: number, options?: { duration?: number }): Promise<void>;
	swipe(from: { x: number; y: number }, to: { x: number; y: number }, duration?: number): Promise<void>;
	/** Enter text into the focused field. Uses the pasteboard, never keystrokes. */
	inputText(text: string): Promise<void>;
	home(): Promise<void>;
}

export function flatten(node: UiNode, out: UiNode[] = []): UiNode[] {
	out.push(node);
	for (const child of node.children) flatten(child, out);
	return out;
}

/** First node whose label, identifier or value contains `needle`, case-insensitively. */
export function findNode(snapshot: UiSnapshot, needle: string): UiNode | null {
	const lowered = needle.toLowerCase();
	for (const node of flatten(snapshot.root)) {
		if (!node.visible || node.frame.width <= 0 || node.frame.height <= 0) continue;
		const haystack = `${node.label}\u0000${node.identifier}\u0000${node.value}`.toLowerCase();
		if (haystack.includes(lowered)) return node;
	}
	return null;
}

export function centerOf(node: UiNode): { x: number; y: number } {
	return { x: node.frame.x + node.frame.width / 2, y: node.frame.y + node.frame.height / 2 };
}

// ── Simulator: baguette ─────────────────────────────────────────────────────

interface BaguetteNode {
	role?: string;
	label?: string | null;
	identifier?: string | null;
	value?: string | null;
	title?: string | null;
	enabled?: boolean;
	hidden?: boolean;
	frame?: { x?: number; y?: number; width?: number; height?: number };
	children?: BaguetteNode[];
}

function fromBaguette(node: BaguetteNode): UiNode {
	const frame = node.frame ?? {};
	return {
		role: node.role ?? "",
		label: node.label ?? node.title ?? "",
		identifier: node.identifier ?? "",
		value: node.value == null ? "" : String(node.value),
		frame: {
			x: frame.x ?? 0,
			y: frame.y ?? 0,
			width: frame.width ?? 0,
			height: frame.height ?? 0,
		},
		enabled: node.enabled !== false,
		visible: node.hidden !== true,
		children: (node.children ?? []).map(fromBaguette),
	};
}

/** baguette interleaves `[baguette] …` progress lines with its JSON payload. */
function jsonPayload(stdout: string): string {
	const start = stdout.indexOf("{");
	if (start < 0) throw new Error(`baguette produced no JSON: ${stdout.trim().slice(0, 300)}`);
	return stdout.slice(start);
}

export class SimulatorDriver implements UiDriver {
	readonly kind = "simulator" as const;

	constructor(readonly target: string) {}

	async describe(): Promise<UiSnapshot> {
		const result = await run(["baguette", "describe-ui", "--udid", this.target], { timeout: 60_000 });
		if (result.code !== 0) {
			const why = `${result.stderr}${result.stdout}`.trim().slice(0, 300);
			throw new Error(
				/no accessibility data/i.test(why)
					? "no accessibility data — launch an app first (a freshly booted device has no frontmost app)"
					: `baguette describe-ui failed: ${why}`,
			);
		}
		const parsed = JSON.parse(jsonPayload(result.stdout)) as BaguetteNode;
		const root = fromBaguette(parsed);
		// The application element carries the real screen frame on some builds.
		const screen = root.frame.width > 0 ? root.frame : (root.children[0]?.frame ?? root.frame);
		return { screen: { width: screen.width, height: screen.height }, root, nodeCount: flatten(root).length };
	}

	async screenshot(path: string): Promise<string> {
		await runOk(["baguette", "screenshot", "--udid", this.target, "--format", "png", "-o", path], {
			timeout: 60_000,
		});
		return path;
	}

	async tap(x: number, y: number, options: { duration?: number } = {}): Promise<void> {
		const { screen } = await this.describe();
		const argv = [
			"baguette",
			"tap",
			"--udid",
			this.target,
			"--x",
			String(Math.round(x)),
			"--y",
			String(Math.round(y)),
			"--width",
			String(Math.round(screen.width)),
			"--height",
			String(Math.round(screen.height)),
		];
		if (options.duration) argv.push("--duration", String(options.duration));
		await runOk(argv, { timeout: 60_000 });
	}

	async swipe(from: { x: number; y: number }, to: { x: number; y: number }, duration = 0.35): Promise<void> {
		const { screen } = await this.describe();
		await runOk(
			[
				"baguette",
				"swipe",
				"--udid",
				this.target,
				"--start-x",
				String(Math.round(from.x)),
				"--start-y",
				String(Math.round(from.y)),
				"--end-x",
				String(Math.round(to.x)),
				"--end-y",
				String(Math.round(to.y)),
				"--width",
				String(Math.round(screen.width)),
				"--height",
				String(Math.round(screen.height)),
				"--duration",
				String(duration),
			],
			{ timeout: 60_000 },
		);
	}

	/**
	 * Paste rather than type. `baguette type` sends HID keystrokes through the
	 * simulator's active IME: with a Korean keyboard enabled, ASCII " abc123"
	 * has been measured to land as "뮻123".
	 */
	async inputText(text: string): Promise<void> {
		await runOk(["baguette", "paste", "--udid", this.target, "--text", text], { timeout: 60_000 });
	}

	async home(): Promise<void> {
		// `press --button home` is a no-op on Face ID devices — there is no home
		// button for the HID layer to reach.
		await runOk(["baguette", "swipe-to-home", "--udid", this.target], { timeout: 60_000 });
	}
}

// ── Real device: WebDriverAgent ─────────────────────────────────────────────

const XML_ATTRIBUTE = /([\w:-]+)="([^"]*)"/g;

/**
 * Parse WDA's XCUITest page source.
 *
 * WDA emits a small, strictly-nested XML document with no namespaces, mixed
 * content or CDATA, so a tag scanner is enough and avoids pulling an XML
 * parser into the dependency set for one call site.
 */
export function parseWdaSource(xml: string): UiNode {
	const root: UiNode = {
		role: "AXApplication",
		label: "",
		identifier: "",
		value: "",
		frame: { x: 0, y: 0, width: 0, height: 0 },
		enabled: true,
		visible: true,
		children: [],
	};
	const stack: UiNode[] = [root];
	const tag = /<(\/?)([A-Za-z][\w.]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g;
	let match = tag.exec(xml);
	let sawRoot = false;
	while (match) {
		const [, closing, name, attrText, selfClosing] = match;
		if (closing) {
			if (stack.length > 1) stack.pop();
		} else if (name !== "?xml") {
			const attributes: Record<string, string> = {};
			XML_ATTRIBUTE.lastIndex = 0;
			for (const attribute of (attrText ?? "").matchAll(XML_ATTRIBUTE)) {
				attributes[attribute[1]!] = attribute[2]!;
			}
			const node: UiNode = {
				role: name ?? "",
				label: attributes.label ?? attributes.name ?? "",
				identifier: attributes.name ?? "",
				value: attributes.value ?? "",
				frame: {
					x: Number.parseFloat(attributes.x ?? "0") || 0,
					y: Number.parseFloat(attributes.y ?? "0") || 0,
					width: Number.parseFloat(attributes.width ?? "0") || 0,
					height: Number.parseFloat(attributes.height ?? "0") || 0,
				},
				enabled: attributes.enabled !== "false",
				visible: attributes.visible !== "false",
				children: [],
			};
			if (!sawRoot) {
				sawRoot = true;
				root.role = node.role;
				root.label = node.label;
				root.identifier = node.identifier;
				root.frame = node.frame;
				if (!selfClosing) stack.push(root);
			} else {
				stack.at(-1)?.children.push(node);
				if (!selfClosing) stack.push(node);
			}
		}
		match = tag.exec(xml);
	}
	return root;
}

export class DeviceDriver implements UiDriver {
	readonly kind = "device" as const;

	constructor(
		readonly target: string,
		private readonly session: WebDriverSession,
	) {}

	async describe(): Promise<UiSnapshot> {
		const [xml, rect] = await Promise.all([pageSource(this.session), windowRect(this.session)]);
		const root = parseWdaSource(xml);
		return {
			screen: { width: rect.width, height: rect.height },
			root,
			nodeCount: flatten(root).length,
		};
	}

	async screenshot(path: string): Promise<string> {
		const base64 = await screenshotBase64(this.session);
		await Bun.write(path, Buffer.from(base64, "base64"));
		return path;
	}

	async tap(x: number, y: number, options: { duration?: number } = {}): Promise<void> {
		await pointerActions(this.session, [
			{ type: "pointerMove", duration: 0, x: Math.round(x), y: Math.round(y) },
			{ type: "pointerDown", button: 0 },
			{ type: "pause", duration: Math.round((options.duration ?? 0.05) * 1000) },
			{ type: "pointerUp", button: 0 },
		]);
	}

	async swipe(from: { x: number; y: number }, to: { x: number; y: number }, duration = 0.35): Promise<void> {
		await pointerActions(this.session, [
			{ type: "pointerMove", duration: 0, x: Math.round(from.x), y: Math.round(from.y) },
			{ type: "pointerDown", button: 0 },
			{ type: "pointerMove", duration: Math.round(duration * 1000), x: Math.round(to.x), y: Math.round(to.y) },
			{ type: "pointerUp", button: 0 },
		]);
	}

	async inputText(text: string): Promise<void> {
		await execute(this.session, "mobile: type", [{ text }]);
	}

	async home(): Promise<void> {
		await execute(this.session, "mobile: pressButton", [{ name: "home" }]);
	}
}

export function evidencePath(kind: string, extension: string): string {
	return join(LAZY_HOME, "evidence", `${kind}-${Date.now()}.${extension}`);
}
