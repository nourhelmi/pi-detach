import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { bridgeEnabled, bridgeTeamRequest } from "../runtime-bridge.ts";

type Details = Record<string, unknown>;
const TEAM_TOOL_NAMES = ["team_status", "team_message", "team_manage"] as const;
const result = (text: string, details: Details): AgentToolResult<Details> => ({ content: [{ type: "text", text }], details });

function requireTeam(enabled: boolean, ctx: ExtensionContext, requireBridge: boolean): void {
	if (!enabled) throw new Error("TEAM_MODE_INACTIVE: enter the managed team workstream first.");
	if (requireBridge && !bridgeEnabled()) throw new Error("TEAM_RUNTIME_UNAVAILABLE: managed runtime transport is required.");
	if (!ctx.sessionManager.getSessionId()) throw new Error("PI_DETACH_SESSION_REQUIRED");
}

/** Registration seam for /cos: emit `advisor:team-mode` with `{ enabled: true }`.
 * Managed teammate processes inherit ADVISOR_TEAM_MODE=1 and start enabled. */
export function registerManagedTeamTools(pi: ExtensionAPI, options: { enabled?: boolean; request?: typeof bridgeTeamRequest } = {}): void {
	let enabled = options.enabled ?? process.env.ADVISOR_TEAM_MODE === "1";
	const teamRequest = options.request ?? bridgeTeamRequest;
	const requireBridge = options.request === undefined;
	const visibleTeamTools = options.request === undefined && process.env.ADVISOR_BRIDGE_CHILD_STATE ? TEAM_TOOL_NAMES.slice(0, 2) : TEAM_TOOL_NAMES;
	const syncActiveTools = () => {
		if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
		const withoutTeam = pi.getActiveTools().filter(name => !TEAM_TOOL_NAMES.includes(name as typeof TEAM_TOOL_NAMES[number]));
		pi.setActiveTools(enabled ? [...new Set([...withoutTeam, ...visibleTeamTools])] : withoutTeam);
	};
	pi.events?.on("advisor:team-mode", (value: unknown) => {
		if (value && typeof value === "object" && typeof (value as { enabled?: unknown }).enabled === "boolean") {
			enabled = (value as { enabled: boolean }).enabled;
			syncActiveTools();
		}
	});

	pi.registerTool({
		name: "team_status",
		label: "Team: Status",
		description: "Show the managed workstream roster, shared context, current assignments, exact transport targets, retained assignment/repair history, and honest requested-versus-observed runtime identity.",
		promptSnippet: "team_status — inspect managed teammates and message/assignment readiness.",
		parameters: Type.Object({}),
		executionMode: "parallel",
		async execute(_toolCallId, _params, _signal, _update, ctx) {
			requireTeam(enabled, ctx, requireBridge);
			const details = await teamRequest(ctx, "team.status", {}) as Details;
			if (details.active === false) return result("Managed team mode is available; no roster has been initialized in this workstream.", details);
			const members = Array.isArray(details.members) ? details.members as Array<{ name?: string; status?: string; node?: { status?: string }; transport?: { messageable?: boolean }; requested?: { model?: string; effort?: string }; observed?: { runtime?: string | null; model?: string | null; effort?: string | null } }> : [];
			const lines = members.map(member => {
				const ready = member.transport?.messageable ? "busy; message queue available" : "not messageable";
				const requested = `requested model ${member.requested?.model ?? "unknown"}, effort ${member.requested?.effort ?? "unknown"}`;
				const observed = `observed runtime ${member.observed?.runtime ?? "unknown"}, model ${member.observed?.model ?? "unknown"}, effort ${member.observed?.effort ?? "unknown"}`;
				return `${member.name ?? "unnamed"}: ${member.status ?? member.node?.status ?? "unknown"} (${ready}); ${requested}; ${observed}`;
			});
			return result(lines.length ? lines.join("\n") : "Managed team is active with no enlisted teammates.", details);
		},
		renderCall() { return new Text("team status", 0, 0); },
		renderResult(output) { const details = output.details as { members?: unknown[] } | undefined; return new Text(`${details?.members?.length ?? 0} teammate(s)`, 0, 0); },
	});

	pi.registerTool({
		name: "team_message",
		label: "Team: Message",
		description: "Send advice or context to a busy managed teammate by name/id, or from a teammate to root. Acceptance means queued transport only; it never claims read/done and never changes scope or assignment.",
		promptSnippet: "team_message — queue non-authoritative advice to a managed teammate or root.",
		parameters: Type.Object({
			to: Type.String({ description: "Teammate name/id, or root when called by a teammate." }),
			text: Type.String({ description: "Advice/context only. This cannot grant work or mutate an assignment." }),
		}),
		executionMode: "parallel",
		async execute(toolCallId, params, _signal, _update, ctx) {
			requireTeam(enabled, ctx, requireBridge);
			const details = await teamRequest(ctx, "team.message", { toolCallId, to: params.to, text: params.text }) as Details;
			return result(`Message ${String(details.messageId ?? "accepted")}: ${String(details.status ?? "accepted")}; read unknown; done unknown.`, details);
		},
		renderCall(args) { return new Text(`message ${args.to}`, 0, 0); },
		renderResult(output) { return new Text(String((output.details as { status?: string } | undefined)?.status ?? "unknown"), 0, 0); },
	});

	pi.registerTool({
		name: "team_manage",
		label: "Team: Manage",
		description: "Root-only managed roster operations: enlist a keep-alive advisor candidate launched after team-mode binding, rename it, update shared context, give it a distinct new assignment, or retire it after descendant settlement.",
		promptSnippet: "team_manage — enlist, rename, set context, assign new work, or retire.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("enlist"), Type.Literal("rename"), Type.Literal("context"), Type.Literal("assign"), Type.Literal("retire")]),
			runId: Type.Optional(Type.String({ description: "Existing bg_agent run ID for enlist." })),
			to: Type.Optional(Type.String({ description: "Current teammate name/id for rename, assign, or retire." })),
			name: Type.Optional(Type.String({ description: "Roster name for enlist or rename." })),
			text: Type.Optional(Type.String({ description: "Shared workstream context for context." })),
			assignmentId: Type.Optional(Type.String({ description: "Unique ID for a distinct new assignment." })),
			task: Type.Optional(Type.String({ description: "Task for a distinct new assignment." })),
			acceptance: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 12 })),
			riskTier: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("standard"), Type.Literal("high")])),
		}),
		executionMode: "parallel",
		async execute(toolCallId, params, _signal, _update, ctx) {
			requireTeam(enabled, ctx, requireBridge);
			const payload: Record<string, unknown> = { toolCallId };
			if (params.action === "enlist") { if (!params.runId || !params.name) throw new Error("TEAM_MANAGE_INPUT: enlist requires runId and name."); payload.runId = params.runId; payload.name = params.name; }
			else if (params.action === "rename") { if (!params.to || !params.name) throw new Error("TEAM_MANAGE_INPUT: rename requires to and name."); payload.to = params.to; payload.name = params.name; }
			else if (params.action === "context") { if (!params.text) throw new Error("TEAM_MANAGE_INPUT: context requires text."); payload.text = params.text; }
			else if (params.action === "assign") {
				if (!params.to || !params.assignmentId || !params.task || !params.acceptance?.length || !params.riskTier) throw new Error("TEAM_MANAGE_INPUT: assign requires to, assignmentId, task, acceptance, and riskTier.");
				Object.assign(payload, { to: params.to, assignmentId: params.assignmentId, task: params.task, acceptance: params.acceptance, riskTier: params.riskTier });
			} else { if (!params.to) throw new Error("TEAM_MANAGE_INPUT: retire requires to."); payload.to = params.to; }
			const details = await teamRequest(ctx, `team.${params.action}`, payload) as Details;
			return result(`Team ${params.action}: ${String(details.status ?? details.outcome ?? "accepted")}.`, details);
		},
		renderCall(args) { return new Text(`team ${args.action}${args.to ? ` ${args.to}` : ""}`, 0, 0); },
		renderResult(output) { const details = output.details as { status?: string; outcome?: string } | undefined; return new Text(details?.status ?? details?.outcome ?? "accepted", 0, 0); },
	});
	pi.on("session_start", syncActiveTools);
}
