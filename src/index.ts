#!/usr/bin/env bun
/**
 * lazy-ios — one MCP server for iOS build/test automation.
 *
 * Replaces the three-server arrangement (appium-mcp + `xcrun mcpbridge` +
 * the baguette CLI driven by hand) with a single process that owns the whole
 * lifecycle. The consolidation is not cosmetic: the two defects that motivated
 * it — simulators created and never reclaimed, real-device sessions failing
 * every time — are both *ownership* problems that no individual server could
 * fix, because each one only saw its own slice.
 *
 *   simulator leak  → every device is leased in a ledger, and only devices
 *                     lazy-ios created can ever be shut down or deleted
 *   real device     → the RemoteXPC/tunnel/WDA preconditions are checked
 *                     before a session is attempted, and reported by name
 *
 * Tool surface is deliberately small. `ios_run` is the one a lazy user needs.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { discoverProject, listSchemes } from "./build/xcodebuild.ts";
import { readLedger } from "./core/ledger.ts";
import { doctor } from "./doctor.ts";
import { ensureAppium, stopAppium } from "./ios/appium.ts";
import { listRealDevices, preflightRealDevice } from "./ios/device.ts";
import { listSimulators, reapSimulators } from "./ios/simulator.ts";
import { runLazy, type Step } from "./run.ts";
import { PreflightBlocked, closeAll, closeSession, getSession, listSessions, openSession } from "./session.ts";
import { centerOf, evidencePath, findNode, flatten } from "./ui/driver.ts";

const server = new McpServer(
	{ name: "lazy-ios", version: "0.1.0" },
	{
		instructions:
			"Single entry point for iOS build/test automation on simulators and physical devices. " +
			"Start with ios_run: it discovers the project, builds, takes a simulator under lease, installs, " +
			"launches, drives the scripted steps, captures screenshot + accessibility evidence, and releases " +
			"the device. Use ios_doctor when something fails — it names the failing precondition. " +
			"lazy-ios only ever shuts down or deletes simulators it created itself; devices that already " +
			"existed are reported but never touched.",
	},
);

function json(value: unknown): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
	if (error instanceof PreflightBlocked) {
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(
						{
							error: error.message,
							blocked: error.report.checks.filter((check) => check.severity === "blocked"),
							humanActions: error.report.humanActions,
							hint: "These steps need a human (one needs root). lazy-ios will not run sudo for you.",
						},
						null,
						2,
					),
				},
			],
			isError: true,
		};
	}
	return { content: [{ type: "text", text: `${(error as Error).message}` }], isError: true };
}

const stepSchema = z
	.union([
		z.object({ tap: z.string().describe("tap the first visible element whose label/id/value contains this text") }),
		z.object({ tapAt: z.object({ x: z.number(), y: z.number() }).describe("tap these AX points") }),
		z.object({ text: z.string().describe("enter text into the focused field (pasteboard, IME-safe)") }),
		z.object({
			swipe: z.object({
				fromX: z.number(),
				fromY: z.number(),
				toX: z.number(),
				toY: z.number(),
				duration: z.number().optional(),
			}),
		}),
		z.object({ wait: z.number().describe("milliseconds") }),
		z.object({ shot: z.string().describe("capture a named screenshot") }),
		z.object({ expect: z.string().describe("fail the run unless this text is on screen") }),
		z.object({ home: z.literal(true) }),
	])
	.describe("one scripted UI step");

server.registerTool(
	"ios_run",
	{
		title: "Build, launch and verify an iOS app end to end",
		description:
			"The lazy path: discover the project, build it, take a simulator (or the attached device) under lease, " +
			"install, launch, run the scripted steps, capture screenshot + AX evidence, then release the device. " +
			"Set test:true to run the scheme's XCTest suite instead of a UI pass. The device is always released, " +
			"even when a phase fails.",
		inputSchema: {
			path: z.string().optional().describe("directory containing the .xcworkspace/.xcodeproj (default: cwd)"),
			scheme: z.string().optional().describe("scheme name (default: first scheme)"),
			configuration: z.string().optional().describe("build configuration (default: Debug)"),
			target: z.enum(["simulator", "device", "auto"]).optional().describe("default: simulator"),
			udid: z.string().optional().describe("exact device; simulators given here are adopted, never deleted"),
			runtime: z.string().optional().describe("iOS version for a scratch simulator, e.g. 27.0"),
			deviceType: z.string().optional().describe("simulator model, e.g. 'iPhone 17 Pro'"),
			bundleId: z.string().optional().describe("override the bundle id read from build settings"),
			steps: z.array(stepSchema).optional(),
			test: z.boolean().optional().describe("run xcodebuild test instead of a UI smoke pass"),
			only: z.array(z.string()).optional().describe("-only-testing identifiers"),
			keepOpen: z.boolean().optional().describe("leave the session open for follow-up ios_ui calls"),
			destroy: z.boolean().optional().describe("delete the scratch simulator instead of keeping it warm"),
			developmentTeam: z.string().optional().describe("DEVELOPMENT_TEAM for device builds"),
		},
	},
	async (args) => {
		try {
			return json(await runLazy({ ...args, steps: args.steps as Step[] | undefined }));
		} catch (error) {
			return failure(error);
		}
	},
);

server.registerTool(
	"ios_doctor",
	{
		title: "Diagnose the iOS automation environment",
		description:
			"Measures every precondition: Xcode, baguette version floor, Appium, signed WebDriverAgent, simulator " +
			"pressure, stray helper processes, and — when a phone is attached — the full real-device chain " +
			"(developer mode, appium-ios-remotexpc, tuntap, RemoteXPC tunnel registration). " +
			"fix:true applies only ownership-scoped repairs; foreign simulators and foreign processes are reported, never touched.",
		inputSchema: {
			fix: z.boolean().optional().describe("reclaim expired lazy-ios leases and clear dead process records"),
			destroyScratch: z.boolean().optional().describe("with fix: delete reclaimed scratch simulators instead of keeping them"),
			includeDevice: z.boolean().optional().describe("run the real-device preflight (default: true when a phone is attached)"),
			udid: z.string().optional(),
		},
	},
	async (args) => {
		try {
			return json(await doctor(args));
		} catch (error) {
			return failure(error);
		}
	},
);

server.registerTool(
	"ios_devices",
	{
		title: "List simulators and physical devices with ownership",
		description:
			"Every simulator and attached device, annotated with the lazy-ios lease that holds it. " +
			"'provenance: created' means lazy-ios made it and may reclaim it; 'adopted' and unlisted devices are the user's.",
		inputSchema: {
			bootedOnly: z.boolean().optional(),
		},
	},
	async ({ bootedOnly }) => {
		try {
			const [simulators, devices, ledger] = await Promise.all([listSimulators(), listRealDevices(), readLedger()]);
			return json({
				simulators: simulators
					.filter((simulator) => !bootedOnly || simulator.state === "Booted")
					.map((simulator) => ({
						udid: simulator.udid,
						name: simulator.name,
						runtime: simulator.runtime,
						state: simulator.state,
						lease: ledger.devices[simulator.udid]
							? {
									provenance: ledger.devices[simulator.udid]!.provenance,
									purpose: ledger.devices[simulator.udid]!.purpose,
									holderPid: ledger.devices[simulator.udid]!.holderPid,
									expiresAt: new Date(ledger.devices[simulator.udid]!.expiresAt).toISOString(),
								}
							: null,
					})),
				realDevices: devices,
				sessions: listSessions().map((session) => ({
					id: session.id,
					kind: session.kind,
					udid: session.udid,
					name: session.name,
					bundleId: session.bundleId,
					idleForMs: Date.now() - session.lastUsedAt,
				})),
			});
		} catch (error) {
			return failure(error);
		}
	},
);

server.registerTool(
	"ios_session",
	{
		title: "Open, close or list automation sessions",
		description:
			"Open a leased target for interactive work. Simulator sessions reuse an idle lazy-ios scratch device when " +
			"one matches, so repeated runs stop creating devices. Device sessions run the real-device preflight first " +
			"and refuse with the exact human action when a precondition is missing.",
		inputSchema: {
			action: z.enum(["open", "close", "closeAll", "list"]),
			kind: z.enum(["simulator", "device"]).optional().describe("for open; default simulator"),
			sessionId: z.string().optional().describe("for close"),
			udid: z.string().optional(),
			runtime: z.string().optional(),
			deviceType: z.string().optional(),
			bundleId: z.string().optional(),
			purpose: z.string().optional(),
			fresh: z.boolean().optional().describe("create a new scratch simulator instead of reusing one"),
			destroy: z.boolean().optional().describe("on close: delete the scratch simulator"),
			force: z.boolean().optional().describe("open a device session even when preflight is blocked (diagnostics only)"),
		},
	},
	async (args) => {
		try {
			switch (args.action) {
				case "open": {
					const session =
						args.kind === "device"
							? await openSession({
									kind: "device",
									udid: args.udid,
									bundleId: args.bundleId,
									purpose: args.purpose,
									force: args.force,
								})
							: await openSession({
									kind: "simulator",
									udid: args.udid,
									runtime: args.runtime,
									deviceType: args.deviceType,
									purpose: args.purpose,
									fresh: args.fresh,
								});
					return json({
						sessionId: session.id,
						kind: session.kind,
						udid: session.udid,
						name: session.name,
						runtime: session.runtime,
						disposition: session.simulator?.disposition ?? "attached",
					});
				}
				case "close": {
					if (!args.sessionId) throw new Error("sessionId is required for close");
					return json(await closeSession(args.sessionId, { destroy: args.destroy }));
				}
				case "closeAll":
					return json(await closeAll({ destroy: args.destroy }));
				case "list":
					return json({
						sessions: listSessions().map((session) => ({
							id: session.id,
							kind: session.kind,
							udid: session.udid,
							name: session.name,
							runtime: session.runtime,
							bundleId: session.bundleId,
							openedAt: new Date(session.createdAt).toISOString(),
							idleForMs: Date.now() - session.lastUsedAt,
						})),
					});
			}
		} catch (error) {
			return failure(error);
		}
	},
);

server.registerTool(
	"ios_ui",
	{
		title: "Inspect and drive the screen",
		description:
			"One vocabulary for both backends: baguette/SimulatorHID on a simulator, WebDriverAgent on a phone. " +
			"Coordinates are accessibility points from the same tree 'describe' returns — never screenshot pixels. " +
			"Text entry uses the pasteboard, because HID typing passes through the active IME and corrupts non-ASCII input.",
		inputSchema: {
			sessionId: z.string(),
			action: z.enum(["describe", "find", "tap", "tapAt", "swipe", "text", "screenshot", "home"]),
			query: z.string().optional().describe("for find/tap: substring of label, identifier or value"),
			x: z.number().optional(),
			y: z.number().optional(),
			toX: z.number().optional(),
			toY: z.number().optional(),
			duration: z.number().optional().describe("seconds"),
			text: z.string().optional(),
			maxNodes: z.number().optional().describe("for describe: cap the flattened node list (default 120)"),
		},
	},
	async (args) => {
		try {
			const session = getSession(args.sessionId);
			switch (args.action) {
				case "describe": {
					const snapshot = await session.driver.describe();
					const nodes = flatten(snapshot.root)
						.filter((node) => node.visible && node.frame.width > 0 && (node.label || node.identifier || node.value))
						.slice(0, args.maxNodes ?? 120)
						.map((node) => ({
							role: node.role,
							label: node.label,
							identifier: node.identifier,
							value: node.value,
							center: centerOf(node),
							frame: node.frame,
						}));
					return json({ screen: snapshot.screen, nodeCount: snapshot.nodeCount, nodes });
				}
				case "find": {
					if (!args.query) throw new Error("query is required for find");
					const snapshot = await session.driver.describe();
					const node = findNode(snapshot, args.query);
					return json(node ? { found: true, node, center: centerOf(node) } : { found: false, screen: snapshot.screen });
				}
				case "tap": {
					if (!args.query) throw new Error("query is required for tap");
					const snapshot = await session.driver.describe();
					const node = findNode(snapshot, args.query);
					if (!node) throw new Error(`no visible element matching "${args.query}"`);
					const center = centerOf(node);
					await session.driver.tap(center.x, center.y, { duration: args.duration });
					return json({ tapped: node.label || node.identifier, center });
				}
				case "tapAt": {
					if (args.x === undefined || args.y === undefined) throw new Error("x and y are required for tapAt");
					await session.driver.tap(args.x, args.y, { duration: args.duration });
					return json({ tapped: { x: args.x, y: args.y } });
				}
				case "swipe": {
					if (args.x === undefined || args.y === undefined || args.toX === undefined || args.toY === undefined) {
						throw new Error("x, y, toX and toY are required for swipe");
					}
					await session.driver.swipe({ x: args.x, y: args.y }, { x: args.toX, y: args.toY }, args.duration);
					return json({ swiped: { from: { x: args.x, y: args.y }, to: { x: args.toX, y: args.toY } } });
				}
				case "text": {
					if (args.text === undefined) throw new Error("text is required");
					await session.driver.inputText(args.text);
					return json({ entered: args.text.length });
				}
				case "screenshot": {
					const path = evidencePath("ui", "png");
					await session.driver.screenshot(path);
					return json({ path });
				}
				case "home":
					await session.driver.home();
					return json({ ok: true });
			}
		} catch (error) {
			return failure(error);
		}
	},
);

server.registerTool(
	"ios_project",
	{
		title: "Inspect the buildable project",
		description: "Resolve the workspace/project at a path and list its schemes, configurations and targets.",
		inputSchema: { path: z.string().optional() },
	},
	async ({ path }) => {
		try {
			const project = discoverProject(path ?? process.cwd());
			if (!project) return json({ found: false, searched: path ?? process.cwd() });
			return json({ found: true, project, ...(await listSchemes(project)) });
		} catch (error) {
			return failure(error);
		}
	},
);

server.registerTool(
	"ios_cleanup",
	{
		title: "Reclaim leaked simulators and helper processes",
		description:
			"Closes open sessions and reclaims every lease whose holder is gone. Scratch devices lazy-ios created are " +
			"shut down (or deleted with destroyScratch). Devices lazy-ios did not create are never touched — they are " +
			"listed so a human can decide.",
		inputSchema: {
			destroyScratch: z.boolean().optional(),
			stopAppiumServer: z.boolean().optional().describe("also stop the supervised Appium server"),
		},
	},
	async ({ destroyScratch, stopAppiumServer }) => {
		try {
			const sessions = await closeAll({ destroy: destroyScratch });
			const reaped = await reapSimulators({ destroyScratch });
			const appium = stopAppiumServer ? await stopAppium() : null;
			const { simulators } = await doctor({ includeDevice: false });
			return json({
				closedSessions: sessions.closed,
				// Non-empty means a device is still held; call ios_cleanup again.
				pendingTeardown: sessions.pending,
				reaped,
				appium,
				remaining: simulators,
			});
		} catch (error) {
			return failure(error);
		}
	},
);

server.registerTool(
	"ios_device_preflight",
	{
		title: "Check why a physical device session would fail",
		description:
			"Runs only the real-device chain and returns each precondition by name. The RemoteXPC tunnel step needs " +
			"root; lazy-ios prints the exact command instead of running sudo. ensureAppium:true also starts (or restarts) " +
			"the supervised Appium server — required after installing appium-ios-remotexpc, whose absence the driver caches per process.",
		inputSchema: {
			udid: z.string().optional(),
			ensureAppium: z.boolean().optional(),
			restartAppium: z.boolean().optional(),
		},
	},
	async (args) => {
		try {
			const report = await preflightRealDevice({ udid: args.udid });
			const appium =
				args.ensureAppium || args.restartAppium ? await ensureAppium({ restart: args.restartAppium }) : undefined;
			return json({ ...report, appium });
		} catch (error) {
			return failure(error);
		}
	},
);

const transport = new StdioServerTransport();
await server.connect(transport);
