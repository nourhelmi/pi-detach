/**
 * @file extensions/index.ts — entry point for pi-detach.
 *
 * Holds the run registry for this load, keeps a live ExtensionContext around
 * so completions arriving outside a turn can still ask whether the agent is
 * idle, and tears everything down on `/reload` so a stale registry never
 * outlives its tools.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createNotifier } from "../src/notify.ts";
import { createRegistry } from "../src/registry.ts";
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

	const registry = createRegistry();
	let currentCtx: ExtensionContext | undefined;
	const notifier = createNotifier(pi, registry, () => currentCtx);

	registry.onExit((record) => notifier.runFinished(record));
	registry.onErrorLine((record, line) => notifier.watchErrorLine(record, line));

	registerBgRunTool(pi, registry);
	registerBgWatchTool(pi, registry);
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
		registry.stopAll();
	});

	globalStore[CLEANUP_KEY] = () => {
		registry.stopAll();
	};
}
