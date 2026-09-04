import assert from "node:assert/strict";
import { test } from "node:test";
import { createBbClient } from "../src/bb/client.ts";
const context = { threadId: "parent", projectId: "project", environmentId: "env", serverUrl: "http://127.0.0.1:38886" };
test("uses exact local route, JSON, and manual redirects", async () => {
  let seen: [string, RequestInit] | undefined;
  const client = createBbClient(context, async (url, init) => { seen = [String(url), init ?? {}]; return Response.json({ version: "1", stopped: true }); });
  await client.stop({ version: "1", runId: "run", threadId: "thread" });
  assert.equal(seen?.[0], "http://127.0.0.1:38886/api/v1/plugins/meta-harness/http/v1/agents/stop"); assert.equal(seen?.[1].redirect, "manual"); assert.equal((seen?.[1].headers as Record<string, string>).origin, undefined);
});
test("rejects redirects and extra response keys", async () => {
  await assert.rejects(createBbClient(context, async () => new Response("", { status: 302 })).stop({ version: "1", runId: "r", threadId: "t" }), /redirect/);
  await assert.rejects(createBbClient(context, async () => Response.json({ version: "1", stopped: true, extra: 1 })).stop({ version: "1", runId: "r", threadId: "t" }), /violated protocol/);
});
test("bounds a streaming response even without content-length", async () => {
	const oversized = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(700_000));
			controller.enqueue(new Uint8Array(700_000));
			controller.close();
		},
	});
	await assert.rejects(createBbClient(context, async () => new Response(oversized)).stop({ version: "1", runId: "r", threadId: "t" }), /too large/);
});
