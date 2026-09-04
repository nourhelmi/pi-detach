import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type { BbContext } from "./context.ts";
import {
	BbAgentStartResponseSchema,
	BbAgentStopResponseSchema,
	BbAgentWaitResponseSchema,
	BbWakeAuthorizeResponseSchema,
	type BbAgentStartRequest,
	type BbAgentStartResponse,
	type BbAgentStopRequest,
	type BbAgentStopResponse,
	type BbAgentWaitRequest,
	type BbAgentWaitResponse,
	type BbWakeAuthorizeRequest,
	type BbWakeAuthorizeResponse,
} from "./protocol.ts";

const MAX_RESPONSE_BYTES = 1_000_000;
const TIMEOUT_MS = 10 * 60_000;

export class BbClientError extends Error {
	constructor(
		readonly code: "network" | "http" | "invalid-response" | "redirect",
		message: string,
		readonly status?: number,
	) {
		super(message);
	}
}

export interface BbClient {
	start(input: BbAgentStartRequest): Promise<BbAgentStartResponse>;
	wait(input: BbAgentWaitRequest, signal?: AbortSignal): Promise<BbAgentWaitResponse>;
	stop(input: BbAgentStopRequest): Promise<BbAgentStopResponse>;
	authorizeWake(input: BbWakeAuthorizeRequest): Promise<BbWakeAuthorizeResponse>;
}

async function boundedText(response: Response): Promise<string> {
	const declared = response.headers.get("content-length");
	if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
		throw new BbClientError("invalid-response", "BB plugin response too large or malformed");
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				throw new BbClientError("invalid-response", "BB plugin response too large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes).toString("utf8");
}

export function createBbClient(context: BbContext, fetcher: typeof fetch = fetch): BbClient {
	const prefix = `${context.serverUrl}/api/v1/plugins/meta-harness/http`;
	async function request<T>(path: string, body: unknown, schema: TSchema, signal?: AbortSignal): Promise<T> {
		const timeout = AbortSignal.timeout(TIMEOUT_MS);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
		let response: Response;
		try {
			response = await fetcher(`${prefix}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				redirect: "manual",
				signal: combined,
			});
		} catch (error) {
			throw new BbClientError("network", error instanceof Error ? error.message : String(error));
		}
		if (response.status >= 300 && response.status < 400) throw new BbClientError("redirect", `redirect rejected: ${response.status}`);
		if (!response.ok) throw new BbClientError("http", `BB plugin returned HTTP ${response.status}`, response.status);
		const text = await boundedText(response);
		let value: unknown;
		try { value = JSON.parse(text); } catch { throw new BbClientError("invalid-response", "BB plugin returned invalid JSON"); }
		try { return Value.Parse(schema, value) as T; } catch { throw new BbClientError("invalid-response", "BB plugin response violated protocol"); }
	}
	return {
		start: (input) => request("/v1/agents/start", input, BbAgentStartResponseSchema),
		wait: (input, signal) => request("/v1/agents/wait", input, BbAgentWaitResponseSchema, signal),
		stop: (input) => request("/v1/agents/stop", input, BbAgentStopResponseSchema),
		authorizeWake: (input) => request("/v1/wakes/authorize", input, BbWakeAuthorizeResponseSchema),
	};
}
