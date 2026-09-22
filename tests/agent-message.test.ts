import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { appendAgentMessageMcpArgs } from "../src/herdr/driver.ts";
import { registerBridgeDelivery, resetBridgeClients } from "../src/runtime-bridge.ts";
import { registerAgentMessageTool, resolveAgentMessageClientPath } from "../src/tools/agent-message.ts";

const ENV_KEYS = [
	"AGENT_MESSAGE_CLIENT", "AGENT_MESSAGE_DESCRIPTOR", "AGENT_MESSAGE_CLI", "AGENT_MESSAGE_NODE",
	"ADVISOR_BRIDGE_CHILD_STATE", "ADVISOR_RUNTIME_DESCRIPTOR", "PI_DETACH_RUNTIME_BRIDGE", "PI_DETACH_BACKEND",
] as const;

async function fixture(t: test.TestContext, options: { leaf?: boolean; child?: boolean; localError?: string } = {}) {
	const dir = await mkdtemp("/tmp/pi-detach-agent-message-");
	const bridge = join(dir, "pi-detach-client.mjs");
	const shared = join(dir, "messaging-client.mjs");
	const descriptor = join(dir, "messenger.json");
	const previous = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	await writeFile(bridge, `export const PI_DETACH_CLIENT_VERSION = 1;
export function createPiDetachClient() { return { async request(session, action, payload) {
 globalThis.__agentMessageFixture.local.push({session,action,payload});
 ${options.localError ? `throw Error(${JSON.stringify(options.localError)});` : "return {self:{id:'worker-1',name:'worker'},peers:[],parent:null};"}
} }; }`);
	await writeFile(shared, `
export const agentMessageSchema={type:'object',marker:'shared-schema'};
export const agentMessageTool={name:'agent_message',description:'shared description',inputSchema:agentMessageSchema};
export function parseAgentMessage(input,{messageId}={}) { return {...input,...(['send','reply'].includes(input.action)&&!input.messageId?{messageId:messageId??'msg-generated'}:{})}; }
export async function callAgentMessage(input,{descriptorPath}={}) { globalThis.__agentMessageFixture.parent.push({input,descriptorPath}); return {self:{id:'worker-1',name:'worker'},peers:[],parent:'advisor-root'}; }
export async function routeAgentMessage(input,channels,options) { const args=parseAgentMessage(input,options); globalThis.__agentMessageFixture.channels.push(channels.length); const values=[]; for(const channel of channels) values.push(await channel.request(args)); return values.length===1?values[0]:{self:values[0].self,parent:values[1].parent,peers:[]}; }
export function messageError(error,messageId) { const code=error?.code??(/^[A-Z][A-Z0-9_]+$/.test(error?.message??'')?error.message:'MESSAGE_UNAVAILABLE'); return {ok:false,error:code,...(messageId?{messageId}:{}),...(code==='MESSAGE_TRANSPORT_UNCERTAIN'?{outcomeKnown:false}:{})}; }
`);
	Object.assign(process.env, {
		PI_DETACH_RUNTIME_BRIDGE: bridge,
		ADVISOR_RUNTIME_DESCRIPTOR: join(dir, "root.json"),
		...(options.leaf ? { AGENT_MESSAGE_CLIENT: shared, AGENT_MESSAGE_DESCRIPTOR: descriptor } : {}),
		...(options.child ? { ADVISOR_BRIDGE_CHILD_STATE: join(dir, "child") } : {}),
	});
	delete process.env.PI_DETACH_BACKEND;
	if (!options.leaf) {
		delete process.env.AGENT_MESSAGE_CLIENT;
		delete process.env.AGENT_MESSAGE_DESCRIPTOR;
	}
	if (!options.child) delete process.env.ADVISOR_BRIDGE_CHILD_STATE;
	const state = globalThis as typeof globalThis & { __agentMessageFixture?: { local: unknown[]; parent: unknown[]; channels: number[] } };
	state.__agentMessageFixture = { local: [], parent: [], channels: [] };
	t.after(async () => {
		for (const key of ENV_KEYS) {
			const value = previous[key];
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		delete state.__agentMessageFixture;
		resetBridgeClients();
		await rm(dir, { recursive: true, force: true });
	});
	return { dir, shared, state: state.__agentMessageFixture };
}

const context = (cwd: string) => ({ cwd, sessionManager: { getSessionId: () => "root-session" } }) as unknown as ExtensionContext;

function registeredTool() {
	let tool: any;
	registerAgentMessageTool({ registerTool(value: unknown) { tool = value; } } as unknown as ExtensionAPI);
	assert.ok(tool, "agent_message registered");
	return tool;
}

test("root Pi uses the installed shared schema and local message bridge", async t => {
	const f = await fixture(t);
	const tool = registeredTool();
	assert.equal(tool.parameters.marker, "shared-schema");
	const result = await tool.execute("call.with.invalid/id", { action: "list" }, undefined, undefined, context(f.dir));
	assert.equal(result.details.ok, true);
	assert.deepEqual(f.state.channels, [1]);
	assert.deepEqual(f.state.local, [{ session: "root-session", action: "message", payload: { action: "list" } }]);
});

test("Pi leaves use only their messenger descriptor; child advisors merge their local children", async t => {
	const leaf = await fixture(t, { leaf: true });
	let tool = registeredTool();
	await tool.execute("leaf", { action: "list" }, undefined, undefined, context(leaf.dir));
	assert.deepEqual(leaf.state.channels, [1]);
	assert.equal(leaf.state.local.length, 0, "ordinary leaf never initializes local management");
	assert.equal((leaf.state.parent[0] as { descriptorPath: string }).descriptorPath, join(leaf.dir, "messenger.json"));

	for (const key of ENV_KEYS) delete process.env[key];
	resetBridgeClients();
	const child = await fixture(t, { leaf: true, child: true });
	tool = registeredTool();
	const merged = await tool.execute("child", { action: "list" }, undefined, undefined, context(child.dir));
	assert.equal(merged.details.ok, true);
	assert.deepEqual(child.state.channels, [2]);
	assert.equal(child.state.local.length, 1);
	assert.equal(child.state.parent.length, 1);
});

test("uncertain root submission keeps the generated messageId and is never retried", async t => {
	const f = await fixture(t, { localError: "PI_DETACH_BRIDGE_UNAVAILABLE" });
	const result = await registeredTool().execute("punctuation/is/fine", { action: "send", to: "worker-1", text: "question" }, undefined, undefined, context(f.dir));
	assert.deepEqual(result.details, { ok: false, error: "MESSAGE_TRANSPORT_UNCERTAIN", messageId: "msg-generated", outcomeKnown: false });
	assert.equal(f.state.local.length, 1);
	assert.equal((f.state.local[0] as { payload: { messageId: string } }).payload.messageId, "msg-generated");
	const read = await registeredTool().execute("read", { action: "list" }, undefined, undefined, context(f.dir));
	assert.deepEqual(read.details, { ok: false, error: "MESSAGE_UNAVAILABLE" });
});

test("root Pi preserves safe typed runtime errors without leaking arbitrary details", async t => {
	const f = await fixture(t, { localError: "UNAUTHORIZED" });
	const denied = await registeredTool().execute("denied", { action: "list" }, undefined, undefined, context(f.dir));
	assert.deepEqual(denied.details, { ok: false, error: "UNAUTHORIZED" });
	assert.equal(f.state.local.length, 1);
});

test("root Pi sanitizes runtime implementation details", async t => {
	const f = await fixture(t, { localError: "socket failed at /private/runtime.sock" });
	const result = await registeredTool().execute("details", { action: "list" }, undefined, undefined, context(f.dir));
	assert.deepEqual(result.details, { ok: false, error: "MESSAGE_UNAVAILABLE" });
});

test("native agents receive process-local agent_message MCP argv after existing arguments", () => {
	const env = { AGENT_MESSAGE_NODE: "/usr/bin/node", AGENT_MESSAGE_CLI: "/opt/runtime/messaging-cli.mjs", AGENT_MESSAGE_DESCRIPTOR: "/tmp/messenger.json" };
	const codex = appendAgentMessageMcpArgs(["codex", "--model", "gpt", "-c", "approval_policy=never"], env);
	assert.deepEqual(codex.slice(0, 5), ["codex", "--model", "gpt", "-c", "approval_policy=never"]);
	assert.deepEqual(codex.slice(5), [
		"-c", 'mcp_servers.agent_message.command="/usr/bin/node"',
		"-c", 'mcp_servers.agent_message.args=["/opt/runtime/messaging-cli.mjs","mcp"]',
		"-c", 'mcp_servers.agent_message.env={AGENT_MESSAGE_DESCRIPTOR="/tmp/messenger.json"}',
	]);
	const claude = appendAgentMessageMcpArgs(["claude", "--model", "sonnet"], env);
	assert.equal(claude.at(-2), "--mcp-config");
	assert.deepEqual(JSON.parse(claude.at(-1)!), { mcpServers: { agent_message: { command: "/usr/bin/node", args: ["/opt/runtime/messaging-cli.mjs", "mcp"], env: { AGENT_MESSAGE_DESCRIPTOR: "/tmp/messenger.json" } } } });
	assert.deepEqual(appendAgentMessageMcpArgs(["pi", "--model", "x"], env), ["pi", "--model", "x"]);
	assert.throws(() => appendAgentMessageMcpArgs(["codex"], { AGENT_MESSAGE_DESCRIPTOR: "relative" }), /AGENT_MESSAGE_MCP_CONFIGURATION/);
});

test("configured roots fail honestly when the installed shared client is missing", async t => {
	const dir = await mkdtemp("/tmp/pi-detach-agent-message-missing-");
	t.after(() => rm(dir, { recursive: true, force: true }));
	const bridge = join(dir, "pi-detach-client.mjs");
	await writeFile(bridge, "export const PI_DETACH_CLIENT_VERSION = 1;\n");
	assert.throws(() => resolveAgentMessageClientPath({ PI_DETACH_RUNTIME_BRIDGE: bridge }), /AGENT_MESSAGE_CLIENT_MISSING/);
});

test("agent.message receiver attributes exact sender and reply ID and wakes only when idle", async t => {
	const f = await fixture(t);
	await writeFile(join(f.dir, "pi-detach-client.mjs"), `export const PI_DETACH_CLIENT_VERSION = 1; let sent=false;
export function createPiDetachClient() { return { async request(session,action,payload) {
 if(action==='list') return [{runId:'worker-1',node:{}}];
 if(action==='wait'&&!sent) { sent=true; return [
  {id:8,kind:'team.message',message:{id:'shared-id',from:'worker-1',fromName:'legacy',text:'Legacy advice',status:'queued'}},
  {id:9,kind:'agent.message',message:{messageId:'shared-id',from:'worker-1',fromName:'builder',to:'advisor-root',toName:'advisor',text:'Need the API name',replyTo:null,status:'queued',read:null,done:null,replies:[]}}
 ]; }
 if(action==='wait') return []; if(action==='ack') { globalThis.__agentMessageFixture.ack=payload; return {}; } throw Error(action);
} }; }`);
	resetBridgeClients();
	const handlers: Record<string, any> = {};
	const deliveries: any[] = [];
	let idle = true;
	let delivered!: (value: any[]) => void;
	const received = new Promise<any[]>(resolve => { delivered = resolve; });
	registerBridgeDelivery({ on(name: string, fn: any) { handlers[name] = fn; }, registerCommand() {}, sendMessage(message: any, options: any) {
		deliveries.push({ message, options });
		idle = false;
		if (deliveries.length === 2) delivered(deliveries);
	} } as unknown as ExtensionAPI);
	const ctx = { ...context(f.dir), sessionManager: { getSessionId: () => "root-session", getEntries: () => [] }, isIdle: () => idle, ui: { notify() {} } } as unknown as ExtensionContext;
	await handlers.session_start({}, ctx);
	const [legacy, unified] = await received;
	assert.equal(legacy.message.customType, "managed-team-message");
	assert.match(legacy.message.content, /Managed teammate legacy sent advice\/context/);
	assert.doesNotMatch(legacy.message.content, /agent_message|replyTo/);
	assert.deepEqual(legacy.options, { triggerTurn: true });
	assert.equal(unified.message.customType, "managed-agent-message");
	assert.match(unified.message.content, /builder \(worker-1\).*Message ID shared-id.*replyTo shared-id.*does not grant scope, assignment, or write authority/s);
	assert.deepEqual(unified.options, { deliverAs: "steer" });
	assert.equal(unified.message.details.messageId, "shared-id");
	assert.equal(deliveries.length, 2, "team and agent ledgers namespace the same explicit message ID");
	handlers.session_shutdown();
});
