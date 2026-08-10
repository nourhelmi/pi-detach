/**
 * @file extensions/index.ts — entry point for pi-detach.
 *
 * Holds the run registry for this load, keeps a live ExtensionContext around
 * so completions arriving outside a turn can still ask whether the agent is
 * idle, and tears everything down on `/reload` so a stale registry never
 * outlives its tools.
 *
 * When pi itself is running inside a herdr pane (HERDR_ENV=1), watches and
 * agents are hosted in visible herdr panes, and a bg_run that gets promoted
 * to the background is given a live viewer pane. Quick foreground commands
 * never touch the layout; outside herdr everything uses the local
 * detached-process backend, exactly as before.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHerdrCli } from "../src/herdr/cli.ts";
import { detectHerdrContext } from "../src/herdr/context.ts";
import { createHerdrDriver } from "../src/herdr/driver.ts";
import { createPaneManager } from "../src/herdr/panes.ts";
import { createViewerManager } from "../src/herdr/viewer.ts";
import { createNotifier } from "../src/notify.ts";
import { createRegistry } from "../src/registry.ts";
import { registerBgAgentTool } from "../src/tools/bg-agent.ts";
import { registerBgListTool } from "../src/tools/bg-list.ts";
import { registerBgOutputTool } from "../src/tools/bg-output.ts";
import { registerBgRunTool } from "../src/tools/bg-run.ts";
import { registerBgStopTool } from "../src/tools/bg-stop.ts";
import { registerBgWatchTool } from "../src/tools/bg-watch.ts";

const CLEANUP_KEY = "__piDetachCleanup";

export default function registerDetachExtension(pi: ExtensionAPI): void {
	const globalStore = globalThis as Record<string, unknown>;
	const previousCleanup = globalStore[CLEANUP_KEY];
	if (typeof previousCleanup === "function") {
		try {
			(previousCleanup as () => void)();
		} catch {
			// Previous instance is going away regardless.
		}
	}

	const herdrCtx = detectHerdrContext();
	let herdrDriver: ReturnType<typeof createHerdrDriver> | undefined;
	let viewer: ReturnType<typeof createViewerManager> | undefined;
	if (herdrCtx) {
		const cli = createHerdrCli();
		const panes = createPaneManager(cli, herdrCtx);
		herdrDriver = createHerdrDriver({ cli, ctx: herdrCtx, panes });
		viewer = createViewerManager(cli, panes);
	}

	const registry = createRegistry({
		...(herdrDriver ? { herdrDriver } : {}),
		...(viewer ? { onPromoted: viewer.attach } : {}),
	});
	let currentCtx: ExtensionContext | undefined;
	const notifier = createNotifier(pi, registry, () => currentCtx);

	registry.onExit((record) => notifier.runFinished(record));
	registry.onErrorLine((record, line) => notifier.watchErrorLine(record, line));

	registerBgRunTool(pi, registry);
	registerBgWatchTool(pi, registry);
	registerBgAgentTool(pi, registry);
	registerBgOutputTool(pi, registry);
	registerBgListTool(pi, registry);
	registerBgStopTool(pi, registry);

	const track = (_event: unknown, ctx: ExtensionContext): void => {
		currentCtx = ctx;
	};
	pi.on("session_start", track);
	pi.on("agent_start", track);
	pi.on("agent_end", track);
	pi.on("agent_settled", track);
	pi.on("turn_start", track);
	pi.on("turn_end", track);

	pi.on("session_shutdown", (_event, ctx) => {
		currentCtx = ctx;
		// Local runs die with the session; herdr panes stay visible and keep
		// running — the user owns them from here.
		registry.stopAll("shutdown");
	});

	globalStore[CLEANUP_KEY] = () => {
		registry.stopAll("shutdown");
	};
}
