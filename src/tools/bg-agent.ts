/**
 * @file bg-agent.ts — `bg_agent`, a helper coding agent in a visible herdr pane.
 *
 * Starts a real agent (codex, claude, opencode, …) via `herdr agent start`,
 * submits the prompt, and follows the same promote-after-30s contract as
 * bg_run: short turns return inline, long ones detach and wake the session
 * when the agent settles (done, idle, or blocked). The agent stays alive in
 * its pane afterwards, so follow-ups reuse it by name.
 */

import { isAbsolute, resolve } from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatDuration } from "../format.ts";
import type { Registry } from "../registry.ts";
import type { RunRecord } from "../types.ts";

const DEFAULT_PROMOTE_AFTER_MS = 30_000;
const INLINE_TAIL_LINES = 120;

interface Details {
	runId: string;
	promoted: boolean;
	status: string;
	agentState?: string;
	agentName?: string;
	paneId?: string;
	durationMs: number;
}

export function registerBgAgentTool(pi: ExtensionAPI, registry: Registry): void {
	pi.registerTool({
		name: "bg_agent",
		label: "Detach: Agent",
		description:
			"Start a helper coding agent (codex by default) in a visible herdr pane and give it a task. " +
			"Blocks briefly like bg_run; if the agent is still working after the timeout the call " +
			"detaches and the session is woken when the agent settles — done, idle, or blocked on a " +
			"question. The agent stays alive in its pane afterwards; pass its `name` to send follow-up " +
			"prompts to the same agent. Requires pi to be running inside herdr.",
		promptSnippet:
			"bg_agent — run a helper agent (codex, claude, …) in a herdr pane; wakes you when it settles.",
		promptGuidelines: [
			"Use bg_agent for interactive agents with lifecycle states; plain `codex exec …` commands are just bg_run.",
			"Prompts must be self-contained — the helper agent shares no context with this session.",
			"Fan out several bg_agent calls in one message for parallel independent tasks.",
			"When a run reports the agent is blocked, answer it: bg_agent with the same `name` for text, or the herdr CLI (pane send-keys) for menu selections.",
			"Never poll a detached agent run; its settling is delivered to you automatically.",
		],
		parameters: Type.Object({
			prompt: Type.String({
				description: "Task for the helper agent. Self-contained; it shares no context with you.",
			}),
			agent: Type.Optional(
				Type.String({
					description:
						'Agent command line to launch, e.g. "codex", "claude", "opencode". Defaults to "codex". Ignored when `name` is set.',
				}),
			),
			name: Type.Optional(
				Type.String({
					description:
						"Reuse a live agent from an earlier bg_agent run (see its notification or bg_list) instead of starting a new one.",
				}),
			),
			cwd: Type.Optional(
				Type.String({ description: "Working directory. Defaults to the session cwd." }),
			),
			label: Type.Optional(
				Type.String({ description: "Short human-readable name used in notifications and the pane title." }),
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
			const agentCommand = params.agent ?? "codex";
			const label =
				params.label ?? params.name ?? `${agentCommand.split(/\s+/)[0]}: ${params.prompt.slice(0, 32)}`;

			let started: Awaited<ReturnType<Registry["start"]>>;
			try {
				started = await registry.start({
					kind: "agent",
					command: agentCommand,
					cwd,
					label,
					prompt: params.prompt,
					...(params.name ? { reuseName: params.name } : {}),
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `bg_agent failed to start: ${message}` }],
					details: { runId: "", promoted: false, status: "failed", durationMs: 0 },
				};
			}
			const { record, completion } = started;

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
								`Agent ${record.agentName} is working in pane ${record.paneId} — detached after ${waited} as ${record.id}.\n` +
								`You will be woken when it settles (done, idle, or blocked). Do not poll it; continue with other work.`,
						},
					],
					details: {
						runId: record.id,
						promoted: true,
						status: "running",
						...(record.agentName ? { agentName: record.agentName } : {}),
						...(record.paneId ? { paneId: record.paneId } : {}),
						durationMs: Date.now() - record.startedAt,
					},
				};
			}

			const finished = outcome;
			const tail = registry.tail(finished.id, INLINE_TAIL_LINES);
			const duration = (finished.endedAt ?? Date.now()) - finished.startedAt;
			const state = finished.agentState ?? "unknown";
			const header =
				`Agent ${finished.agentName} settled: ${state} in ${formatDuration(duration)} ` +
				`(pane ${finished.paneId}). Follow up with bg_agent({ name: "${finished.agentName}", prompt: "…" }).`;

			return {
				content: [{ type: "text", text: tail.trim() ? `${header}\n\n${tail.trimEnd()}` : header }],
				details: {
					runId: finished.id,
					promoted: false,
					status: finished.status,
					agentState: state,
					...(finished.agentName ? { agentName: finished.agentName } : {}),
					...(finished.paneId ? { paneId: finished.paneId } : {}),
					durationMs: duration,
				},
			};
		},

		renderCall(args) {
			const target = args.name ?? args.agent ?? "codex";
			return new Text(`agent ${target}: ${args.prompt.slice(0, 60)}`, 0, 0);
		},

		renderResult(result) {
			const details = result.details as Details | undefined;
			if (!details) return new Text("", 0, 0);
			if (details.promoted) {
				return new Text(`working in ${details.paneId ?? "pane"} → ${details.runId}`, 0, 0);
			}
			if (details.status === "failed") return new Text("failed to start", 0, 0);
			return new Text(
				`${details.agentState ?? details.status} · ${formatDuration(details.durationMs)}`,
				0,
				0,
			);
		},
	});
}
