/**
 * @file bg-agent.ts — `bg_agent`, a helper Pi role agent in a visible Herdr tab.
 *
 * Starts an interactive Pi agent by default. Configured roles resolve model,
 * reasoning, skill, permissions, and prompt contracts before Herdr receives the
 * command. Explicit non-Pi commands remain available for compatibility.
 */

import { isAbsolute, resolve } from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
	resolveAgentLaunch,
	type ResolvedAgentLaunch,
	type ThinkingLevel,
} from "../agent-profiles.ts";
import { formatDuration } from "../format.ts";
import type { Registry } from "../registry.ts";
import type { RunRecord } from "../types.ts";

const DEFAULT_PROMOTE_AFTER_MS = 30_000;
const INLINE_TAIL_LINES = 120;

const BgAgentParameters = Type.Object({
	prompt: Type.String({
		description: "Task for the helper agent. Self-contained; it shares no context with you.",
	}),
	role: Type.Optional(
		Type.String({
			description:
				"Configured Pi role profile (guardrails: role skill, permissions, turn cap). Cannot be combined with agent.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				'Pi model as "provider/model-id", chosen from the configured model map. Required for every role launch.',
		}),
	),
	thinking: Type.Optional(
		Type.Union(
			[
				Type.Literal("off"),
				Type.Literal("minimal"),
				Type.Literal("low"),
				Type.Literal("medium"),
				Type.Literal("high"),
				Type.Literal("xhigh"),
				Type.Literal("max"),
			],
			{
				description:
					"Reasoning level for the chosen model. Validated against the model map; defaults to the map's default for that model.",
			},
		),
	),
	maxTurns: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Override the role's parent-prompt turn cap for this launch.",
		}),
	),
	anchor: Type.Optional(
		Type.String({
			description: "Concrete command, evidence condition, or artifact that proves the task is done.",
		}),
	),
	requiredSkills: Type.Optional(
		Type.Array(Type.String(), {
			description: "Pi skill names that the role must load for this task.",
			maxItems: 12,
		}),
	),
	agent: Type.Optional(
		Type.String({
			description:
				'Explicit compatibility command, for example "codex" or "claude". Defaults to Pi. Cannot be combined with role and is ignored when `name` is set.',
		}),
	),
	name: Type.Optional(
		Type.String({
			description: "Reuse a live agent from an earlier bg_agent run instead of starting a new one.",
		}),
	),
	keepAlive: Type.Optional(
		Type.Boolean({
			description: "Keep the tab after successful settlement for a planned follow-up. Defaults to false.",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the session cwd." })),
	label: Type.Optional(
		Type.String({ description: "Short human-readable name used in notifications and the tab title." }),
	),
	promoteAfterMs: Type.Optional(
		Type.Number({ description: "Milliseconds to wait before detaching. Defaults to 30000." }),
	),
});

type BgAgentParams = Static<typeof BgAgentParameters>;

interface Details {
	runId: string;
	promoted: boolean;
	status: string;
	agentState?: string;
	agentName?: string;
	paneId?: string;
	role?: string;
	runtime?: string;
	provider?: string;
	model?: string;
	thinking?: string;
	maxTurns?: number;
	reusable?: boolean;
	durationMs: number;
}

interface ExecuteAgentOptions {
	registry: Registry;
	params: BgAgentParams;
	signal: AbortSignal | undefined;
	ctx: ExtensionContext;
}

function launchDetails(launch: ResolvedAgentLaunch): Partial<Details> {
	return {
		...(launch.role ? { role: launch.role } : {}),
		runtime: launch.runtime,
		...(launch.provider ? { provider: launch.provider } : {}),
		...(launch.model ? { model: launch.model } : {}),
		...(launch.thinking ? { thinking: launch.thinking } : {}),
		...(launch.maxTurns ? { maxTurns: launch.maxTurns } : {}),
	};
}

function workingDirectory(requested: string | undefined, current: string): string {
	if (!requested) return current;
	return isAbsolute(requested) ? requested : resolve(current, requested);
}

function agentLabel(params: BgAgentParams): string {
	if (params.label) return params.label;
	if (params.name) return params.name;
	const target = params.role ?? params.agent ?? "pi";
	return `${target.split(/\s+/)[0]}: ${params.prompt.slice(0, 32)}`;
}

async function prepareLaunch(params: BgAgentParams, label: string): Promise<ResolvedAgentLaunch> {
	if (params.name) {
		return { command: params.agent ?? "pi", prompt: params.prompt, runtime: "existing" };
	}
	return resolveAgentLaunch({
		...(params.agent ? { agent: params.agent } : {}),
		...(params.role ? { role: params.role } : {}),
		...(params.model ? { model: params.model } : {}),
		...(params.thinking ? { thinking: params.thinking as ThinkingLevel } : {}),
		...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {}),
		prompt: params.prompt,
		label,
		...(params.anchor ? { anchor: params.anchor } : {}),
		...(params.requiredSkills ? { requiredSkills: params.requiredSkills } : {}),
	});
}

async function waitForOutcome(
	completion: Promise<RunRecord>,
	signal: AbortSignal | undefined,
	promoteAfterMs: number,
): Promise<RunRecord | "promote"> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<"promote">((complete) => {
		timer = setTimeout(() => complete("promote"), promoteAfterMs);
	});
	const abort = new Promise<"promote">((complete) => {
		if (!signal) return;
		if (signal.aborted) complete("promote");
		signal.addEventListener("abort", () => complete("promote"), { once: true });
	});
	try {
		return await Promise.race([completion, timeout, abort]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function promotedResult(
	record: RunRecord,
	launch: ResolvedAgentLaunch,
	keepAlive: boolean,
): AgentToolResult<Details> {
	const waited = formatDuration(Date.now() - record.startedAt);
	const lifecycle = keepAlive
		? "Its tab will remain available for follow-up."
		: "A successful tab closes automatically; blocked or failed tabs stay visible.";
	return {
		content: [
			{
				type: "text",
				text:
					`Agent ${record.agentName} is working in pane ${record.paneId} — detached after ${waited} as ${record.id}.\n` +
					`You will be woken when it settles. ${lifecycle}`,
			},
		],
		details: {
			runId: record.id,
			promoted: true,
			status: "running",
			...launchDetails(launch),
			reusable: keepAlive,
			...(record.agentName ? { agentName: record.agentName } : {}),
			...(record.paneId ? { paneId: record.paneId } : {}),
			durationMs: Date.now() - record.startedAt,
		},
	};
}

function settledFollowUp(finished: RunRecord, keepAlive: boolean): string {
	if (keepAlive) {
		return `Follow up with bg_agent({ name: "${finished.agentName}", prompt: "…", keepAlive: true }).`;
	}
	if (finished.agentState === "done" || finished.agentState === "idle") {
		return "Its successful Herdr tab was closed automatically.";
	}
	return "Its tab remains visible for inspection or input.";
}

function settledResult(
	registry: Registry,
	finished: RunRecord,
	launch: ResolvedAgentLaunch,
	keepAlive: boolean,
): AgentToolResult<Details> {
	const tail = registry.tail(finished.id, INLINE_TAIL_LINES);
	const duration = (finished.endedAt ?? Date.now()) - finished.startedAt;
	const state = finished.agentState ?? "unknown";
	const header =
		`Agent ${finished.agentName} settled: ${state} in ${formatDuration(duration)} ` +
		`(pane ${finished.paneId}). ${settledFollowUp(finished, keepAlive)}`;
	return {
		content: [{ type: "text", text: tail.trim() ? `${header}\n\n${tail.trimEnd()}` : header }],
		details: {
			runId: finished.id,
			promoted: false,
			status: finished.status,
			agentState: state,
			...launchDetails(launch),
			reusable: keepAlive,
			...(finished.agentName ? { agentName: finished.agentName } : {}),
			...(finished.paneId ? { paneId: finished.paneId } : {}),
			durationMs: duration,
		},
	};
}

async function executeAgent(options: ExecuteAgentOptions): Promise<AgentToolResult<Details>> {
	const { registry, params, signal, ctx } = options;
	const cwd = workingDirectory(params.cwd, ctx.cwd);
	const label = agentLabel(params);
	let launch: ResolvedAgentLaunch;
	let started: Awaited<ReturnType<Registry["start"]>>;
	try {
		launch = await prepareLaunch(params, label);
		started = await registry.start({
			kind: "agent",
			command: launch.command,
			cwd,
			label,
			prompt: launch.prompt,
			...(params.name ? { reuseName: params.name } : {}),
			closeOnSettle: !params.keepAlive,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `bg_agent failed to start: ${message}` }],
			details: { runId: "", promoted: false, status: "failed", durationMs: 0 },
		};
	}
	const outcome = await waitForOutcome(
		started.completion,
		signal,
		params.promoteAfterMs ?? DEFAULT_PROMOTE_AFTER_MS,
	);
	if (outcome === "promote") {
		registry.markPromoted(started.record.id);
		return promotedResult(started.record, launch, Boolean(params.keepAlive));
	}
	return settledResult(registry, outcome, launch, Boolean(params.keepAlive));
}

export function registerBgAgentTool(pi: ExtensionAPI, registry: Registry): void {
	pi.registerTool({
		name: "bg_agent",
		label: "Detach: Agent",
		description:
			"Start a helper Pi agent in a visible Herdr tab. Configured roles pin guardrails — role " +
			"skill, permissions, anchor, and turn cap — while `model` and `thinking` are chosen per " +
			"launch from the configured model map. An explicit `agent` command can override Pi for " +
			"compatibility. Successful tabs close by default; set `keepAlive` only for a planned " +
			"follow-up. Requires Pi to run inside Herdr.",
		promptSnippet: "bg_agent — run a visible Pi role agent in Herdr; wakes you when it settles.",
		promptGuidelines: [
			"Use a configured `role` for new delegated work so skill, permissions, and turn cap are explicit.",
			"Choose `model` and `thinking` per launch from the configured model map; pick the cheapest model whose character fits the task.",
			"Every role launch needs a concrete `anchor`; list only the task skills that agent must load.",
			"Prompts must be self-contained — the helper agent shares no context with this session.",
			"Fan out several bg_agent calls in one message only for independent graph nodes.",
			"Use `keepAlive: true` only when the same maker has a planned follow-up; successful tabs otherwise close automatically.",
			"When a run reports the agent is blocked, answer it with the same `name`, or use Herdr pane keys for a menu.",
			"Never poll a detached agent run; its settling is delivered to you automatically.",
		],
		parameters: BgAgentParameters,
		executionMode: "parallel",

		async execute(...args) {
			const [, params, signal, , ctx] = args;
			return executeAgent({ registry, params, signal, ctx });
		},

		renderCall(args) {
			const target = args.name ?? args.role ?? args.agent ?? "pi";
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
