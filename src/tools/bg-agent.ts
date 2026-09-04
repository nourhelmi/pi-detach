/**
 * @file bg-agent.ts — `bg_agent`, a helper role agent in a visible Herdr tab.
 *
 * Starts an interactive Pi agent by default. Configured roles apply prompt
 * contracts before Herdr receives the command. A role can run in Pi or route
 * its selected model through the provider's native Codex/Claude harness.
 */

import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
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
	type WorkerHarness,
} from "../agent-profiles.ts";
import { formatDuration } from "../format.ts";
import type { Registry } from "../registry.ts";
import type { RunRecord } from "../types.ts";

/** Explains a dead reuse `name` from this session's history instead of a bare miss. */
export function agentTombstoneNote(registry: Registry, name: string): string | undefined {
	const past = registry
		.list()
		.find((run) => run.kind === "agent" && run.agentName === name && run.status !== "running");
	if (!past) return undefined;
	const ago = formatDuration(Date.now() - (past.endedAt ?? past.startedAt));
	const artifact = past.resultPath
		? `Its durable result artifact: ${past.resultPath} — read it instead of resuming.`
		: `Read its transcript with bg_output({ runId: "${past.id}" }).`;
	return (
		`It settled ${past.agentState ?? "unknown"} ${ago} ago as run ${past.id} and its pane closed.\n` +
		`${artifact}\n` +
		"Launch a fresh agent for the follow-up (omit `name`), or pass keepAlive: true next time a follow-up is planned."
	);
}

const DEFAULT_PROMOTE_AFTER_MS = 30_000;
const INLINE_TAIL_LINES = 120;

const BgAgentParameters = Type.Object({
	prompt: Type.String({
		description: "Task for the helper agent. Self-contained; it shares no context with you.",
	}),
	role: Type.Optional(
		Type.String({
			description:
				"Configured semantic role contract (role skill, anchor, and instructional turn cap). The selected harness determines runtime. Cannot be combined with agent.",
		}),
	),
	harness: Type.Optional(
		Type.Union([Type.Literal("pi"), Type.Literal("native")], {
			description:
				"Worker harness for a configured role. Defaults to the advisor session preference, then Pi; an explicit profile transport constraint takes precedence.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				'Optional model as "provider/model-id". Forwarded to Pi or translated when native mode selects Codex/Claude.',
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
					"Optional reasoning level. Requires model and is forwarded to Pi or translated when native mode selects Codex/Claude.",
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
			description:
				"Single-criterion shorthand: one concrete command, evidence condition, or artifact that proves the task is done. Prefer `acceptance` for anything nontrivial.",
		}),
	),
	acceptance: Type.Optional(
		Type.Array(Type.String(), {
			maxItems: 12,
			description:
				"Enumerated falsifiable acceptance criteria. Each states a claim the work must survive and how it is proven (command, evidence condition, or artifact). The worker must verify every criterion itself and map its result Claims one-to-one to them.",
		}),
	),
	resultPath: Type.Optional(
		Type.String({
			description: "Optional durable result.md path for a native role worker. Generated automatically when omitted.",
		}),
	),
	requiredSkills: Type.Optional(
		Type.Array(Type.String(), {
			description: "Skill names that the role must load for this task.",
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
	threadId?: string;
	hostId?: string;
	role?: string;
	runtime?: string;
	provider?: string;
	model?: string;
	thinking?: string;
	maxTurns?: number;
	resultPath?: string;
	resultStatus?: string;
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
		...(launch.resultPath ? { resultPath: launch.resultPath } : {}),
	};
}

function workingDirectory(requested: string | undefined, current: string): string {
	if (!requested) return current;
	return isAbsolute(requested) ? requested : resolve(current, requested);
}

async function reserveResultArtifact(path: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	try {
		await writeFile(path, "", { encoding: "utf8", flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(`native result artifact already exists: ${path}`);
		}
		throw error;
	}
}

export async function withReservedResultArtifact<T>(
	path: string,
	start: () => Promise<T>,
): Promise<T> {
	await reserveResultArtifact(path);
	try {
		return await start();
	} catch (error) {
		// The exclusive reservation proves this invocation owns the placeholder.
		// A successfully returned run keeps it for settlement validation.
		await unlink(path).catch(() => undefined);
		throw error;
	}
}

export function agentLabel(params: BgAgentParams): string {
	const role = params.role?.trim().split(/\s+/)[0];
	if (params.label) {
		const label = params.label.trim().replace(/\s+/g, " ");
		const escapedRole = role?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (!escapedRole || new RegExp(`^${escapedRole}(?:$|[\\s·:—-])`, "i").test(label)) {
			return label;
		}
		return `${role} · ${label}`;
	}
	if (params.name) return params.name;

	const command = params.agent?.trim().split(/\s+/)[0];
	const target = role ?? command?.split("/").pop() ?? "pi";
	const meaningful = (params.prompt.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) ?? []).filter(
		(word) =>
			!["a", "an", "and", "for", "in", "of", "on", "or", "please", "that", "the", "this", "to", "with", "you"].includes(
				word.toLowerCase(),
			),
	);
	const prefix = `${target} ·`;
	const words: string[] = [];
	for (const word of meaningful) {
		if (words.length >= 4) break;
		const candidate = `${prefix} ${[...words, word].join(" ")}`;
		if (candidate.length > 32) break;
		words.push(word);
	}
	return `${prefix} ${words.join(" ") || "task"}`;
}

export function workerHarness(params: BgAgentParams): WorkerHarness | undefined {
	const requested = params.harness === "pi" || params.harness === "native" ? params.harness : undefined;
	const value = process.env.PI_DETACH_WORKER_HARNESS;
	const configured = value === "pi" || value === "native" ? value : undefined;
	if (requested && configured && requested !== configured) {
		throw new Error(
			`bg_agent harness ${requested} conflicts with the parent session harness ${configured}`,
		);
	}
	return requested ?? configured;
}

async function prepareLaunch(params: BgAgentParams, label: string): Promise<ResolvedAgentLaunch> {
	if (params.name) {
		return { command: params.agent ?? "pi", prompt: params.prompt, runtime: "existing" };
	}
	const harness = workerHarness(params);
	return resolveAgentLaunch({
		...(params.agent ? { agent: params.agent } : {}),
		...(params.role ? { role: params.role } : {}),
		...(params.model ? { model: params.model } : {}),
		...(params.thinking ? { thinking: params.thinking as ThinkingLevel } : {}),
		...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {}),
		...(harness ? { harness } : {}),
		prompt: params.prompt,
		label,
		...(params.anchor ? { anchor: params.anchor } : {}),
		...(params.acceptance ? { acceptance: params.acceptance } : {}),
		...(params.resultPath ? { resultPath: params.resultPath } : {}),
		...(params.requiredSkills ? { requiredSkills: params.requiredSkills } : {}),
	});
}

export function bbProfilePolicy(launch: ResolvedAgentLaunch, role: string): { allowSubagents: boolean } {
	const policy = launch.profilePolicy;
	if (!policy || policy.tools.length || policy.excludeTools.length) {
		throw new Error("BB profiles cannot use Pi tool filters or omit curated profile metadata");
	}
	const base = ["--advisor-worker-role", role];
	if (policy.cliArgs.length === base.length && policy.cliArgs.every((value, index) => value === base[index])) {
		return { allowSubagents: false };
	}
	const delegated = [...base, "--advisor-worker-allow-subagents"];
	if (policy.cliArgs.length === delegated.length && policy.cliArgs.every((value, index) => value === delegated[index])) {
		return { allowSubagents: true };
	}
	throw new Error("BB profile contains unsupported CLI arguments");
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
	const resultPath = record.resultPath ?? launch.resultPath;
	const surface = record.surface?.kind === "bb"
		? `BB thread ${record.surface.threadId}`
		: `pane ${record.paneId ?? "unknown"}`;
	return {
		content: [
			{
				type: "text",
				text:
					`Agent ${record.agentName} is working in ${surface} — detached after ${waited} as ${record.id}.\n` +
					`You will be woken when it settles. ${lifecycle}` +
					(resultPath ? `\nResult artifact: ${resultPath}` : ""),
			},
		],
		details: {
			runId: record.id,
			promoted: true,
			status: "running",
			...launchDetails(launch),
			...(resultPath ? { resultPath } : {}),
			reusable: keepAlive,
			...(record.agentName ? { agentName: record.agentName } : {}),
			...(record.paneId ? { paneId: record.paneId } : {}),
			...(record.surface?.kind === "bb" ? { threadId: record.surface.threadId, hostId: record.surface.hostId } : {}),
			durationMs: Date.now() - record.startedAt,
		},
	};
}

function settledFollowUp(finished: RunRecord, keepAlive: boolean): string {
	if (finished.surface?.kind === "bb") return "Its BB thread remains visible for inspection.";
	if (keepAlive) {
		return `Follow up with bg_agent({ name: "${finished.agentName}", prompt: "…", keepAlive: true }).`;
	}
	if (finished.agentState === "done" || finished.agentState === "idle") {
		return "Its successful Herdr tab was closed automatically.";
	}
	return "Its tab remains visible for inspection or input.";
}

export function settledResult(
	registry: Registry,
	finished: RunRecord,
	launch: ResolvedAgentLaunch,
	keepAlive: boolean,
): AgentToolResult<Details> {
	const tail = registry.tail(finished.id, INLINE_TAIL_LINES);
	const duration = (finished.endedAt ?? Date.now()) - finished.startedAt;
	const state = finished.agentState ?? "unknown";
	const resultPath = finished.resultPath ?? launch.resultPath;
	const surface = finished.surface?.kind === "bb"
		? `BB thread ${finished.surface.threadId}`
		: `pane ${finished.paneId ?? "unknown"}`;
	const header =
		`Agent ${finished.agentName} settled: ${state}` +
		(finished.resultStatus ? ` · result Status: ${finished.resultStatus}` : "") +
		` in ${formatDuration(duration)} (${surface}). ${settledFollowUp(finished, keepAlive)}` +
		(resultPath ? `\nResult artifact: ${resultPath}` : "");
	return {
		content: [{ type: "text", text: tail.trim() ? `${header}\n\n${tail.trimEnd()}` : header }],
		details: {
			runId: finished.id,
			promoted: false,
			status: finished.status,
			agentState: state,
			...launchDetails(launch),
			...(resultPath ? { resultPath } : {}),
			...(finished.resultStatus ? { resultStatus: finished.resultStatus } : {}),
			reusable: keepAlive,
			...(finished.agentName ? { agentName: finished.agentName } : {}),
			...(finished.paneId ? { paneId: finished.paneId } : {}),
			...(finished.surface?.kind === "bb" ? { threadId: finished.surface.threadId, hostId: finished.surface.hostId } : {}),
			durationMs: duration,
		},
	};
}

async function executeAgent(options: ExecuteAgentOptions): Promise<AgentToolResult<Details>> {
	const { registry, params, signal, ctx } = options;
	const cwd = workingDirectory(params.cwd, ctx.cwd);
	if (process.env.BB_THREAD_ID && params.name) {
		if (
			params.role || params.agent || params.harness || params.model || params.thinking ||
			params.maxTurns !== undefined || params.anchor || params.acceptance || params.resultPath ||
			params.requiredSkills || params.cwd || params.label || params.promoteAfterMs !== undefined
		) {
			return { content: [{ type: "text", text: "bg_agent failed to continue: BB continuation accepts only name, prompt, and keepAlive." }], details: { runId: "", promoted: false, status: "failed", durationMs: 0 } };
		}
		const match = registry.list().find((record) => record.agentName === params.name && record.surface?.kind === "bb");
		if (!match) return { content: [{ type: "text", text: `bg_agent failed to continue: no BB agent named ${params.name}` }], details: { runId: "", promoted: false, status: "failed", durationMs: 0 } };
		try {
			const record = await registry.continue(match.id, params.prompt);
			return {
				content: [{ type: "text", text: `Continued run ${record.id} in the same BB thread ${record.surface?.kind === "bb" ? record.surface.threadId : "unknown"}.` }],
				details: {
					runId: record.id,
					promoted: true,
					status: record.status,
					runtime: "existing",
					reusable: Boolean(params.keepAlive),
					...(record.agentName ? { agentName: record.agentName } : {}),
					...(record.surface?.kind === "bb" ? { threadId: record.surface.threadId, hostId: record.surface.hostId } : {}),
					durationMs: Date.now() - record.startedAt,
				},
			};
		} catch (error) {
			return { content: [{ type: "text", text: `bg_agent failed to continue: ${error instanceof Error ? error.message : String(error)}` }], details: { runId: match.id, promoted: false, status: "failed", durationMs: 0 } };
		}
	}
	const label = agentLabel(params);
	let launch: ResolvedAgentLaunch;
	let bbAllowSubagents: boolean | undefined;
	let started: Awaited<ReturnType<Registry["start"]>>;
	try {
		launch = await prepareLaunch(params, label);
		if (process.env.BB_THREAD_ID) {
			if (!params.role || params.agent || params.harness === "native" || launch.runtime !== "pi") {
				throw new Error("BB v1 supports configured Pi roles only");
			}
			if (!launch.provider || !launch.model) throw new Error("BB bg_agent requires an exact provider/model");
			if (params.thinking === "minimal") throw new Error("BB does not support reasoning level minimal");
			const profilePolicy = bbProfilePolicy(launch, params.role);
			bbAllowSubagents = profilePolicy.allowSubagents;
			if (!launch.maxTurns) throw new Error("BB profile requires an exact positive turn cap");
			const resultPath = launch.resultPath ?? params.resultPath ?? join(process.env.ADVISOR_STATE_ROOT ?? join(homedir(), ".advisor"), "runs", "native", randomUUID(), "result.md");
			launch = {
				...launch,
				resultPath,
				prompt: `${launch.prompt}\n\nRESULT ARTIFACT:\nCreate the parent directory and write the durable bounded result to ${resultPath}.\nInclude Status, Claims, Evidence, Files, Decisions, and Remaining Risk. Return this path in the final response.`,
			};
		}
		const start = () => registry.start({
			kind: "agent",
			command: launch.command,
			cwd,
			label,
			prompt: launch.prompt,
			...(params.name ? { reuseName: params.name } : {}),
			closeOnSettle: !params.keepAlive,
			...(launch.resultPath ? { requiredArtifactPath: launch.resultPath } : {}),
			...(launch.resultDiscovery ? { resultDiscovery: launch.resultDiscovery } : {}),
			...(process.env.BB_THREAD_ID && launch.provider && launch.model ? {
				piLaunchSpec: {
					provider: launch.provider,
					model: launch.model,
					reasoning: (launch.thinking ?? "off") as "off" | "low" | "medium" | "high" | "xhigh" | "max",
					prompt: launch.prompt,
					role: launch.role!,
					maxTurns: launch.maxTurns!,
					allowSubagents: bbAllowSubagents!,
					...(launch.resultPath ? { resultPath: launch.resultPath } : {}),
				},
			} : {}),
		});
		started = launch.resultPath
			? await withReservedResultArtifact(launch.resultPath, start)
			: await start();
	} catch (error) {
		let message = error instanceof Error ? error.message : String(error);
		if (params.name && message.includes("no live herdr agent named")) {
			const tombstone = agentTombstoneNote(registry, params.name);
			if (tombstone) message += `\n${tombstone}`;
		}
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

export function bgAgentResultLabel(result: AgentToolResult<any>): string {
	const details = result.details as Partial<Details> | undefined;
	if (details?.promoted && details.runId) {
		return `working in ${details.threadId ?? details.paneId ?? "surface"} → ${details.runId}`;
	}
	if (details?.status === "failed") return "failed to start";
	const status = details?.agentState ?? details?.status;
	if (typeof status === "string" && Number.isFinite(details?.durationMs)) {
		return `${status} · ${formatDuration(details?.durationMs as number)}`;
	}
	if (typeof status === "string") return status;
	const fallback = result.content
		.map((part) => ("text" in part ? part.text : ""))
		.filter(Boolean)
		.join("\n")
		.trim();
	return fallback || "blocked";
}

export function registerBgAgentTool(pi: ExtensionAPI, registry: Registry): void {
	pi.registerTool({
		name: "bg_agent",
		label: "Detach: Agent",
		description:
			"Start a helper agent in a visible Herdr tab. Configured semantic roles carry " +
			"instructional role skills, optional anchors, and turn caps. `harness`, `model`, and " +
			"`thinking` select Pi or a provider-native Codex/Claude runtime. An explicit `agent` command can override Pi for " +
			"compatibility. Successful tabs close by default; set `keepAlive` only for a planned " +
			"follow-up. Requires Pi to run inside Herdr.",
		promptSnippet: "bg_agent — run a visible role agent in Herdr; wakes you when it settles.",
		promptGuidelines: [
			"Use a configured `role` when delegated work needs a role skill, anchor policy, or turn cap.",
			"Omit `model` and `thinking` to use Pi's default runtime identity; when supplied, they pass through to Pi.",
			"Spell out `acceptance` criteria: enumerated falsifiable claims with their proof method. `anchor` remains a single-criterion shorthand; roles that require one accept either.",
			"Prompts must be self-contained — the helper agent shares no context with this session.",
			"Fan out several bg_agent calls in one message only for independent tasks.",
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
			return new Text(bgAgentResultLabel(result), 0, 0);
		},
	});
}
