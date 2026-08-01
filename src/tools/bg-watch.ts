/**
 * @file bg-watch.ts — `bg_watch`, for processes that never exit on their own.
 *
 * Returns immediately and stays quiet. A watch only interrupts the session
 * when it dies unexpectedly or prints a line matching `errorPattern`; healthy
 * output just accumulates for `bg_output`.
 */

import { isAbsolute, resolve } from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Registry } from "../registry.ts";

interface Details {
	runId: string;
	deduped: boolean;
	command: string;
	cwd: string;
}

export function registerBgWatchTool(pi: ExtensionAPI, registry: Registry): void {
	pi.registerTool({
		name: "bg_watch",
		label: "Detach: Watch",
		description:
			"Start a long-lived process that is not expected to exit — a dev server, " +
			"a file watcher, a log tail. Returns immediately and stays silent while healthy. " +
			"You are only interrupted if it exits unexpectedly or prints a line matching " +
			"errorPattern. Read its output at any time with bg_output.",
		promptSnippet: "bg_watch — start a dev server or watcher that runs quietly in the background.",
		promptGuidelines: [
			"Use bg_watch only for processes that never terminate on their own; use bg_run for anything that finishes.",
			"Starting the same command in the same directory twice returns the existing run instead of a second process. The same command in a different worktree is a separate run and will start normally.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run." }),
			cwd: Type.Optional(
				Type.String({ description: "Working directory. Defaults to the session cwd." }),
			),
			label: Type.Optional(
				Type.String({ description: "Short human-readable name used in notifications." }),
			),
			errorPattern: Type.Optional(
				Type.String({
					description:
						"Case-insensitive regex. A matching output line interrupts the session, " +
						"at most once per minute per run.",
				}),
			),
		}),
		executionMode: "parallel",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<Details>> {
			const cwd = params.cwd
				? isAbsolute(params.cwd)
					? params.cwd
					: resolve(ctx.cwd, params.cwd)
				: ctx.cwd;

			const { record, deduped } = await registry.start({
				kind: "watch",
				command: params.command,
				cwd,
				...(params.label ? { label: params.label } : {}),
				...(params.errorPattern ? { errorPattern: params.errorPattern } : {}),
			});

			const where = record.paneId ? `\n  pane: ${record.paneId} (visible in herdr)` : "";
			const text = deduped
				? `Already watching this command in ${cwd} as ${record.id}. Reusing it.`
				: `Watching as ${record.id}: $ ${record.command}\n  cwd: ${cwd}${where}\n` +
					`Silent while healthy. Read output with bg_output({ runId: "${record.id}" }), stop with bg_stop.`;

			return {
				content: [{ type: "text", text }],
				details: { runId: record.id, deduped, command: record.command, cwd },
			};
		},

		renderCall(args) {
			return new Text(`watch $ ${args.command}`, 0, 0);
		},

		renderResult(result) {
			const details = result.details as Details | undefined;
			return new Text(details ? `watching → ${details.runId}` : "", 0, 0);
		},
	});
}
