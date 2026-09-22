import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Type } from "typebox";

import { bridgeAgentMessageRequest, bridgeEnabled } from "../runtime-bridge.ts";

type MessageArgs = Record<string, unknown> & { action?: string; messageId?: string };
type MessageChannel = { request(args: MessageArgs): Promise<unknown>; parent?: boolean };
type MessageFailure = { ok: false; error: string; messageId?: string; outcomeKnown?: false };
interface MessagingClientModule {
	agentMessageSchema: Record<string, unknown>;
	agentMessageTool: { name: string; description: string };
	parseAgentMessage(input: unknown, options?: { messageId?: string }): MessageArgs;
	callAgentMessage(input: unknown, options?: { descriptorPath?: string }): Promise<unknown>;
	routeAgentMessage(input: unknown, channels: MessageChannel[], options?: { messageId?: string }): Promise<unknown>;
	messageError(error: unknown, messageId?: string): MessageFailure;
}

const require = createRequire(import.meta.url);
const managedConfig = (env: NodeJS.ProcessEnv) => join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "pi-detach-runtime.json");

function sharedClientBeside(path: string): string {
	const candidate = join(dirname(path), "messaging-client.mjs");
	if (!existsSync(candidate)) throw new Error("AGENT_MESSAGE_CLIENT_MISSING");
	return candidate;
}

/** Resolve only installed code paths. Loading this module never connects to or starts a runtime. */
export function resolveAgentMessageClientPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env.AGENT_MESSAGE_CLIENT !== undefined) {
		if (!isAbsolute(env.AGENT_MESSAGE_CLIENT) || !existsSync(env.AGENT_MESSAGE_CLIENT)) {
			throw new Error("AGENT_MESSAGE_CLIENT_INVALID");
		}
		return env.AGENT_MESSAGE_CLIENT;
	}
	if (env.PI_DETACH_RUNTIME_BRIDGE) {
		if (!isAbsolute(env.PI_DETACH_RUNTIME_BRIDGE)) throw new Error("AGENT_MESSAGE_CLIENT_INVALID");
		return sharedClientBeside(env.PI_DETACH_RUNTIME_BRIDGE);
	}
	const configPath = managedConfig(env);
	if (!existsSync(configPath)) return undefined;
	let config: { client?: unknown };
	try {
		config = JSON.parse(readFileSync(configPath, "utf8")) as { client?: unknown };
	} catch {
		throw new Error("AGENT_MESSAGE_CLIENT_INVALID");
	}
	if (typeof config.client !== "string" || !isAbsolute(config.client)) throw new Error("AGENT_MESSAGE_CLIENT_INVALID");
	return sharedClientBeside(config.client);
}

function loadMessagingClient(path: string): MessagingClientModule {
	const module = require(path) as Partial<MessagingClientModule>;
	if (!module.agentMessageSchema || module.agentMessageTool?.name !== "agent_message"
		|| typeof module.parseAgentMessage !== "function" || typeof module.callAgentMessage !== "function"
		|| typeof module.routeAgentMessage !== "function" || typeof module.messageError !== "function") {
		throw new Error("AGENT_MESSAGE_CLIENT_VERSION");
	}
	return module as MessagingClientModule;
}

function localFailure(error: unknown, args: MessageArgs): Error & { code: string; messageId?: string } {
	const source = error instanceof Error ? error.message : "MESSAGE_UNAVAILABLE";
	let code = /^[A-Z][A-Z0-9_]+$/.test(source) ? source : "MESSAGE_UNAVAILABLE";
	if (source === "PI_DETACH_BRIDGE_UNAVAILABLE") {
		code = ["send", "reply"].includes(String(args.action))
			? "MESSAGE_TRANSPORT_UNCERTAIN"
			: "MESSAGE_UNAVAILABLE";
	}
	return Object.assign(new Error(code), { code, ...(args.messageId ? { messageId: args.messageId } : {}) });
}

async function localRequest(ctx: ExtensionContext, args: MessageArgs): Promise<unknown> {
	try {
		return await bridgeAgentMessageRequest(ctx, args);
	} catch (error) {
		throw localFailure(error, args);
	}
}

function toolResult(value: unknown): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
}

/** Register the shared-schema Pi facade without initializing advisor/team management. */
export function registerAgentMessageTool(pi: ExtensionAPI): boolean {
	const descriptorPath = process.env.AGENT_MESSAGE_DESCRIPTOR;
	if (!descriptorPath && !bridgeEnabled()) return false;
	const clientPath = resolveAgentMessageClientPath();
	if (!clientPath) return false;
	const client = loadMessagingClient(clientPath);

	pi.registerTool({
		name: client.agentMessageTool.name,
		label: "Agent Message",
		description: client.agentMessageTool.description,
		parameters: Type.Unsafe<MessageArgs>(client.agentMessageSchema),
		executionMode: "parallel",
		async execute(_toolCallId, input, _signal, _update, ctx) {
			let args: MessageArgs | undefined;
			try {
				args = client.parseAgentMessage(input);
				const channels: MessageChannel[] = [];
				// A descriptor marks a managed leaf. Only an advisor child grant authorizes
				// adding that process's local child runtime to its parent neighborhood.
				if (!descriptorPath || (process.env.ADVISOR_BRIDGE_CHILD_STATE && bridgeEnabled())) {
					channels.push({ request: (value) => localRequest(ctx, value) });
				}
				if (descriptorPath) {
					channels.push({ parent: true, request: (value) => client.callAgentMessage(value, { descriptorPath }) });
				}
				const value = await client.routeAgentMessage(args, channels, args.messageId ? { messageId: args.messageId } : undefined);
				return toolResult({ ok: true, value });
			} catch (error) {
				const messageId = args?.messageId
					?? (error && typeof error === "object" && typeof (error as { messageId?: unknown }).messageId === "string"
						? (error as { messageId: string }).messageId : undefined);
				return toolResult(client.messageError(error, messageId));
			}
		},
	});
	return true;
}
