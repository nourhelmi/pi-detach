import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerManagedTeamTools } from "../src/tools/team.ts";

test("managed team tools stay gated until /cos activation and expose honest message semantics", async () => {
	const requests: Array<{ action: string; payload: object }> = [];
	const request = async (_ctx: ExtensionContext, action: string, payload: object) => {
		requests.push({ action, payload });
		if (action === "team.status") return {
			active: true,
			members: [{ name: "alpha", status: "active", transport: { messageable: true }, requested: { model: "requested-model", effort: "high" }, observed: { runtime: "pi", model: null, effort: null } }],
			storageLimits: { teamStateBytes: 16 * 1024 * 1024, commandEnvelopeBytes: 32 * 1024, responseEnvelopeBytes: 1024 * 1024, messageTextBytes: 16 * 1024 },
			projectionLimits: { statusMessages: 128, statusMessageTextBytes: 1024 },
		};
		if (action === "team.message") return { messageId: "message-1", status: "accepted", read: null, done: null };
		return { outcome: action.slice(5) };
	};
	const tools = new Map<string, ToolDefinition<any, any, any>>(); const events = new Map<string, (value: unknown) => void>();
	let activeTools = ["read", "bash", "team_status", "team_message", "team_manage"];
	registerManagedTeamTools({
		registerTool(tool: ToolDefinition<any, any, any>) { tools.set(tool.name, tool); },
		events: { on(name: string, handler: (value: unknown) => void) { events.set(name, handler); } },
		getActiveTools() { return activeTools; }, setActiveTools(names: string[]) { activeTools = names; },
	} as unknown as ExtensionAPI, { enabled: false, request });
	const ctx = { cwd: "/tmp", sessionManager: { getSessionId: () => "root-session" } } as unknown as ExtensionContext;
	assert.deepEqual(activeTools, ["read", "bash"]);
	await assert.rejects(tools.get("team_status")!.execute("status", {}, undefined, undefined, ctx), /TEAM_MODE_INACTIVE/);
	events.get("advisor:team-mode")?.({ enabled: true });
	assert.deepEqual(activeTools, ["read", "bash", "team_status", "team_message", "team_manage"]);
	const status = await tools.get("team_status")!.execute("status", {}, undefined, undefined, ctx);
	assert.match((status.content[0] as { text: string }).text, /alpha: active \(busy; message queue available\).*requested model requested-model, effort high.*observed runtime pi, model unknown, effort unknown/);
	assert.deepEqual(status.details, {
		active: true,
		members: [{ name: "alpha", status: "active", transport: { messageable: true }, requested: { model: "requested-model", effort: "high" }, observed: { runtime: "pi", model: null, effort: null } }],
		storageLimits: { teamStateBytes: 16 * 1024 * 1024, commandEnvelopeBytes: 32 * 1024, responseEnvelopeBytes: 1024 * 1024, messageTextBytes: 16 * 1024 },
		projectionLimits: { statusMessages: 128, statusMessageTextBytes: 1024 },
	}, "public tool preserves runtime byte and projection bounds without inventing a quota");
	const message = await tools.get("team_message")!.execute("message", { to: "alpha", text: "check transport" }, undefined, undefined, ctx);
	assert.match((message.content[0] as { text: string }).text, /read unknown; done unknown/);
	await tools.get("team_manage")!.execute("assign", { action: "assign", to: "alpha", assignmentId: "contract-2", task: "new work", acceptance: ["proof"], riskTier: "high" }, undefined, undefined, ctx);
	assert.deepEqual(requests, [
		{ action: "team.status", payload: {} },
		{ action: "team.message", payload: { toolCallId: "message", to: "alpha", text: "check transport" } },
		{ action: "team.assign", payload: { toolCallId: "assign", to: "alpha", assignmentId: "contract-2", task: "new work", acceptance: ["proof"], riskTier: "high" } },
	]);
	events.get("advisor:team-mode")?.({ enabled: false });
	assert.deepEqual(activeTools, ["read", "bash"]);
	await assert.rejects(tools.get("team_status")!.execute("status-after-exit", {}, undefined, undefined, ctx), /TEAM_MODE_INACTIVE/);
});
