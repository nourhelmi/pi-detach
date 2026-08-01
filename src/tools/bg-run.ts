/**
 * @file bg-run.ts — `bg_run`, the default way to execute a shell command.
 *
 * Always starts blocking. If the command outruns `promoteAfterMs` the tool
 * returns immediately and the run keeps going in the background, announcing
 * itself when it exits. The agent never decides between foreground and
 * background — the clock does.
 */

import { isAbsolute, resolve } from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatDuration, outcomeLabel } from "../format.ts";
import type { Registry } from "../registry.ts";
import type { RunRecord } from "../types.ts";

const DEFAULT_PROMOTE_AFTER_MS = 30_000;
const INLINE_TAIL_LINES = 200;

interface Details {
	runId: string;
	promoted: boolean;
	deduped: boolean;
	status: string;
	exitCode?: number;
	durationMs: number;
	command: string;
}

export function registerBgRunTool(pi: ExtensionAPI, registry: Registry): void {
	pi.registerTool({
		name: "bg_run",
		label: "Detach: Run",
		description:
			"Run a shell command. Blocks and returns the output like a normal shell tool, " +
			"but if the command is still running after a timeout (default 30s) it is promoted " +
			"to the background: the tool returns a runId immediately and the session is woken " +
			"with the result when the command finishes. Call it several times in one message " +
			"to fan out concurrent work such as parallel codex runs or test suites.",
		promptSnippet:
			"bg_run — run a shell command; long ones auto-detach and wake you when done.",
		promptGuidelines: [
			"Prefer bg_run over a plain shell tool for anything that might take more than a few seconds — builds, test suites, codex runs, installs.",
			"To fan out, issue multiple bg_run calls in a single message; they execute concurrently.",
			"Never poll a promoted run in a loop. Its completion is delivered to you automatically.",
			"Use bg_watch instead for processes that never exit on their own, such as dev servers or file watchers.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run." }),
			cwd: Type.Optional(
				Type.String({ description: "Working directory. Defaults to the session cwd." }),
			),
			label: Type.Optional(
				Type.String({ description: "Short human-readable name used in notifications." }),
			),
			promoteAfterMs: Type.Optional(
				Type.Number({
					description:
						"Milliseconds to wait before detaching to the background. Defaults to 30000.",
				}),
			),
		}),
		executionMode: "parallel",

		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<Details>> {
			const cwd = params.cwd
				? isAbsolute(params.cwd)
					? params.cwd
					: resolve(ctx.cwd, params.cwd)
				: ctx.cwd;

			const { record, completion, deduped } = registry.start({
				kind: "run",
				command: params.command,
				cwd,
				...(params.label ? { label: params.label } : {}),
			});

			const promoteAfter = params.promoteAfterMs ?? DEFAULT_PROMOTE_AFTER_MS;

			let timer: NodeJS.Timeout | undefined;
			const promoteOnTimeout = new Promise<"promote">((r) => {
				timer = setTimeout(() => r("promote"), promoteAfter);
			});
			const promoteOnAbort = new Promise<"promote">((r) => {
				if (!signal) return;
				if (signal.aborted) r("promote");
				signal.addEventListener("abort", () => r("promote"), { once: true });
			});

			const outcome = await Promise.race([
				completion.then((finished): RunRecord => finished),
				promoteOnTimeout,
				promoteOnAbort,
			]);
			if (timer) clearTimeout(timer);

			if (outcome === "promote") {
				registry.markPromoted(record.id);
				const waited = formatDuration(Date.now() - record.startedAt);
				return {
					content: [
						{
							type: "text",
							text:
								`Still running after ${waited} — detached to the background as ${record.id}.\n` +
								`You will be notified when it finishes. Do not poll it; continue with other work.\n` +
								`$ ${record.command}\n  cwd: ${cwd}`,
						},
					],
					details: {
						runId: record.id,
						promoted: true,
						deduped,
						status: "running",
						durationMs: Date.now() - record.startedAt,
						command: record.command,
					},
				};
			}

			const finished = outcome;
			const tail = registry.tail(finished.id, INLINE_TAIL_LINES);
			const duration = (finished.endedAt ?? Date.now()) - finished.startedAt;
			const header = deduped
				? `Reused already-running ${finished.id} for this command — ${outcomeLabel(finished)} in ${formatDuration(duration)}`
				: `${outcomeLabel(finished)} in ${formatDuration(duration)}`;

			return {
				content: [{ type: "text", text: tail.trim() ? `${header}\n\n${tail.trimEnd()}` : header }],
				details: {
					runId: finished.id,
					promoted: false,
					deduped,
					status: finished.status,
					...(finished.exitCode !== undefined ? { exitCode: finished.exitCode } : {}),
					durationMs: duration,
					command: finished.command,
				},
			};
		},

		renderCall(args) {
			return new Text(`$ ${args.command}`, 0, 0);
		},

		renderResult(result) {
			const details = result.details as Details | undefined;
			if (!details) return new Text("", 0, 0);
			if (details.promoted) {
				return new Text(`detached → ${details.runId}`, 0, 0);
			}
			return new Text(
				`${details.status} ${details.exitCode ?? ""} · ${formatDuration(details.durationMs)}`.trim(),
				0,
				0,
			);
		},
	});
}
