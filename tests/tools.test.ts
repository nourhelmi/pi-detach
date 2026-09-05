/**
 * Drives the real extension entry point with a stand-in host so the tool
 * bodies — auto-promote, cwd resolution, dedupe wording — are exercised
 * exactly as pi would call them.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import registerDetachExtension from "../extensions/index.ts";
import type { Registry } from "../src/registry.ts";
import type { RunRecord } from "../src/types.ts";
import {
	agentLabel,
	agentTombstoneNote,
	bgAgentResultLabel,
	promotedResult,
	settledResult,
	withReservedResultArtifact,
	workerHarness,
} from "../src/tools/bg-agent.ts";

type AnyTool = ToolDefinition<any, any, any>;

interface Sent {
	content: string;
	options: { triggerTurn?: boolean; deliverAs?: string } | undefined;
}

function host(options: { idle?: boolean; cwd?: string } = {}) {
	const tools = new Map<string, AnyTool>();
	const sent: Sent[] = [];
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();

	const pi = {
		registerTool: (tool: AnyTool) => tools.set(tool.name, tool),
		on: (event: string, handler: (e: unknown, c: ExtensionContext) => void) =>
			handlers.set(event, handler),
		sendMessage: (message: { content: string }, opts?: Sent["options"]) =>
			sent.push({ content: message.content, options: opts }),
	} as unknown as ExtensionAPI;

	// Unit tests must never inherit a developer's live Herdr session and create real panes.
	const previousNoHerdr = process.env.PI_DETACH_NO_HERDR;
	process.env.PI_DETACH_NO_HERDR = "1";
	try {
		registerDetachExtension(pi);
	} finally {
		if (previousNoHerdr === undefined) delete process.env.PI_DETACH_NO_HERDR;
		else process.env.PI_DETACH_NO_HERDR = previousNoHerdr;
	}

	const ctx = {
		cwd: options.cwd ?? tmpdir(),
		isIdle: () => options.idle ?? true,
	} as ExtensionContext;

	handlers.get("session_start")?.({}, ctx);

	const call = async (
		name: string,
		params: unknown,
		signal?: AbortSignal,
	): Promise<AgentToolResult<any>> => {
		const tool = tools.get(name);
		assert.ok(tool, `tool ${name} is not registered`);
		return tool.execute("test-call", params as never, signal, undefined, ctx);
	};

	const shutdown = () => handlers.get("session_shutdown")?.({}, ctx);

	return { tools, sent, call, shutdown };
}

const text = (result: AgentToolResult<any>): string =>
	result.content.map((part) => ("text" in part ? part.text : "")).join("");

test("bg_agent renders guard-blocked results without undefined timing", () => {
	const label = bgAgentResultLabel({
		content: [
			{
				type: "text",
				text: "Advisor native sessions use a configured role and Claude model, not agent: claude.",
			},
		],
		details: {},
	});
	assert.equal(
		label,
		"Advisor native sessions use a configured role and Claude model, not agent: claude.",
	);
	assert.doesNotMatch(label, /undefined|NaN/);
});

test("registers the full toolset", () => {
	const { tools, shutdown } = host();
	assert.deepEqual(
		[...tools.keys()].sort(),
		["bg_agent", "bg_await", "bg_list", "bg_output", "bg_run", "bg_stop", "bg_watch"],
	);
	shutdown();
});

test("bg_agent labels compose a role with a provided purpose", () => {
	assert.equal(
		agentLabel({ role: "builder", label: "adaptive dock", prompt: "Implement it" }),
		"builder · adaptive dock",
	);
	assert.equal(
		agentLabel({ role: "builder", label: "builder · adaptive dock", prompt: "Implement it" }),
		"builder · adaptive dock",
	);
});

test("bg_agent fallback labels use concise meaningful prompt words", () => {
	const label = agentLabel({
		role: "sidecar",
		prompt: "Please investigate the phone bridge synchronization failure immediately",
	});
	assert.equal(label, "sidecar · investigate phone");
	assert(label.length <= 32);
	assert.equal(
		agentLabel({ agent: "codex --model x", prompt: "Review the API changes" }),
		"codex · Review API changes",
	);
});

test("the parent session harness is authoritative over per-launch overrides", () => {
	const previous = process.env.PI_DETACH_WORKER_HARNESS;
	process.env.PI_DETACH_WORKER_HARNESS = "native";
	try {
		assert.equal(workerHarness({ role: "builder", prompt: "Build." }), "native");
		assert.equal(workerHarness({ role: "builder", harness: "native", prompt: "Build." }), "native");
		assert.throws(
			() => workerHarness({ role: "builder", harness: "pi", prompt: "Build." }),
			/conflicts with the parent session harness native/,
		);
		process.env.PI_DETACH_WORKER_HARNESS = "pi";
		assert.equal(workerHarness({ role: "checker", prompt: "Check." }), "pi");
		assert.throws(
			() => workerHarness({ role: "checker", harness: "native", prompt: "Check." }),
			/conflicts with the parent session harness pi/,
		);
	} finally {
		if (previous === undefined) delete process.env.PI_DETACH_WORKER_HARNESS;
		else process.env.PI_DETACH_WORKER_HARNESS = previous;
	}
});

test("bg_run returns inline when the command finishes in time", async () => {
	const { call, sent, shutdown } = host();
	const result = await call("bg_run", { command: "echo inline-result" });
	assert.equal(result.details.promoted, false);
	assert.equal(result.details.exitCode, 0);
	assert.match(text(result), /inline-result/);
	assert.equal(sent.length, 0);
	shutdown();
});

test("bg_run detaches once it outruns the promote threshold", async () => {
	const { call, sent, shutdown } = host();
	const result = await call("bg_run", {
		command: "sleep 0.4; echo late-result",
		promoteAfterMs: 50,
	});
	assert.equal(result.details.promoted, true);
	assert.equal(result.details.status, "running");
	assert.match(text(result), /detached to the background/);
	assert.match(text(result), new RegExp(result.details.runId));

	await new Promise((r) => setTimeout(r, 700));
	assert.equal(sent.length, 1);
	assert.match(sent[0]?.content ?? "", /late-result/);
	assert.equal(sent[0]?.options?.triggerTurn, true);
	shutdown();
});

test("a detached run steers into a busy session instead of interrupting idle", async () => {
	const { call, sent, shutdown } = host({ idle: false });
	await call("bg_run", { command: "sleep 0.3", promoteAfterMs: 50 });
	await new Promise((r) => setTimeout(r, 600));
	assert.equal(sent[0]?.options?.deliverAs, "steer");
	shutdown();
});

test("aborting the turn detaches the run rather than killing it", async () => {
	const { call, shutdown } = host();
	const controller = new AbortController();
	const pending = call("bg_run", { command: "sleep 2" }, controller.signal);
	setTimeout(() => controller.abort(), 50);
	const result = await pending;
	assert.equal(result.details.promoted, true);
	shutdown();
});

test("bg_run resolves a relative cwd against the session directory", async () => {
	const { call, shutdown } = host({ cwd: "/usr" });
	const result = await call("bg_run", { command: "pwd", cwd: "bin" });
	assert.match(text(result), /\/usr\/bin/);
	shutdown();
});

test("bg_watch returns immediately and bg_list reports it", async () => {
	const { call, shutdown } = host();
	const started = await call("bg_watch", { command: "sleep 5", label: "fake-dev" });
	assert.match(text(started), /Watching as/);

	const listed = await call("bg_list", {});
	assert.match(text(listed), /fake-dev/);
	assert.match(text(listed), /running/);

	const stopped = await call("bg_stop", { runId: started.details.runId });
	assert.equal(stopped.details.stopped, true);
	shutdown();
});

test("bg_watch reuses an identical run in the same directory", async () => {
	const { call, shutdown } = host();
	const first = await call("bg_watch", { command: "sleep 5" });
	const second = await call("bg_watch", { command: "sleep 5" });
	assert.equal(second.details.deduped, true);
	assert.equal(second.details.runId, first.details.runId);
	assert.match(text(second), /Reusing it/);
	shutdown();
});

test("bg_watch treats a different worktree as a separate run", async () => {
	const { call, shutdown } = host();
	const first = await call("bg_watch", { command: "sleep 5", cwd: tmpdir() });
	const second = await call("bg_watch", { command: "sleep 5", cwd: "/usr" });
	assert.equal(second.details.deduped, false);
	assert.notEqual(second.details.runId, first.details.runId);
	shutdown();
});

test("bg_output reads a finished run and reports unknown ids", async () => {
	const { call, shutdown } = host();
	const run = await call("bg_run", { command: "printf 'one\\ntwo\\n'" });
	const output = await call("bg_output", { runId: run.details.runId, grep: "two" });
	assert.match(text(output), /two/);
	assert.doesNotMatch(text(output).split("\n\n")[1] ?? "", /one/);

	const missing = await call("bg_output", { runId: "nope00" });
	assert.match(text(missing), /No run with id/);
	shutdown();
});

test("shutdown terminates everything still running", async () => {
	const { call, shutdown } = host();
	const watch = await call("bg_watch", { command: "sleep 30" });
	shutdown();
	await new Promise((r) => setTimeout(r, 100));
	const listed = await call("bg_list", {});
	assert.doesNotMatch(text(listed), new RegExp(`${watch.details.runId} · watch · running`));
});

test("bg_await resolves inline when the until condition matches the first probe", async () => {
	const { call, shutdown } = host();
	const result = await call("bg_await", {
		command: "echo 'status: Succeeded'",
		untilPattern: "succeeded",
		intervalSeconds: 5,
		timeoutSeconds: 60,
	});
	assert.equal(result.details.promoted, false);
	assert.equal(result.details.exitCode, 0);
	assert.match(text(result), /Until condition matched/);
	shutdown();
});

test("bg_await flags a hard failure via failPattern", async () => {
	const { call, shutdown } = host();
	const result = await call("bg_await", {
		command: "echo 'status: Aborted'; false",
		failPattern: "aborted",
		intervalSeconds: 5,
		timeoutSeconds: 60,
	});
	assert.equal(result.details.exitCode, 1);
	assert.match(text(result), /Failure condition matched/);
	shutdown();
});

test("bg_await rejects an invalid pattern without starting a run", async () => {
	const { call, shutdown } = host();
	const result = await call("bg_await", { command: "true", untilPattern: "(" });
	assert.equal(result.details.status, "failed");
	assert.match(text(result), /not a valid regex/);
	shutdown();
});

test("bg_agent name-reuse misses are explained by a session tombstone", () => {
	const registry = {
		list: () => [
			{
				id: "abc123",
				kind: "agent",
				backend: "herdr",
				label: "checker · review",
				command: "pi",
				cwd: "/tmp",
				status: "exited",
				agentName: "checker-review-x",
				agentState: "done",
				resultPath: "/tmp/result.md",
				startedAt: Date.now() - 120_000,
				endedAt: Date.now() - 60_000,
				durationMs: 60_000,
			},
		],
	} as unknown as Registry;
	const note = agentTombstoneNote(registry, "checker-review-x");
	assert.ok(note);
	assert.match(note, /settled done/);
	assert.match(note, /\/tmp\/result\.md/);
	assert.equal(agentTombstoneNote(registry, "other"), undefined);
});

test("failed native starts remove only their reserved empty result", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-detach-result-start-failure-"));
	const resultPath = join(dir, "result.md");
	try {
		await assert.rejects(
			withReservedResultArtifact(resultPath, async () => {
				assert.equal(existsSync(resultPath), true, "reservation exists before registry start");
				throw new Error("start refused");
			}),
			/start refused/,
		);
		assert.equal(existsSync(resultPath), false, "owned placeholder is removed after start failure");
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("successfully started native runs retain their result reservation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-detach-result-started-"));
	const resultPath = join(dir, "result.md");
	try {
		const value = await withReservedResultArtifact(resultPath, async () => "started");
		assert.equal(value, "started");
		assert.equal(existsSync(resultPath), true, "settlement owns validation of a started run");
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("bg_agent result builders surface settlement notes and result notes", () => {
	const stalled: RunRecord = {
		id: "agent1",
		kind: "agent",
		command: "pi",
		cwd: "/tmp",
		label: "builder",
		status: "exited",
		backend: "herdr",
		paneId: "w1:p7",
		agentName: "builder-abc",
		agentState: "stalled",
		resultPath: "/tmp/discovered/result.md",
		settlementNote: "required result artifact is invalid: empty /tmp/discovered/result.md",
		startedAt: 0,
		endedAt: 1000,
		promoted: false,
		logPath: "/tmp/output.log",
	};
	const registry = { tail: () => "" } as unknown as Registry;
	const settledStall = settledResult(
		registry,
		stalled,
		{ command: "pi", prompt: "Build.", runtime: "pi" },
		false,
	);
	const promotedStall = promotedResult(
		stalled,
		{ command: "pi", prompt: "Build.", runtime: "pi" },
		false,
	);
	assert.match(text(settledStall), /settled: stalled — required result artifact is invalid: empty/);
	assert.equal(settledStall.details.settlementNote, stalled.settlementNote);
	assert.equal(promotedStall.details.settlementNote, stalled.settlementNote);

	const done: RunRecord = {
		...stalled,
		id: "agent2",
		agentState: "done",
		resultStatus: "PASS",
		resultNotes: ["missing Evidence", "empty Files"],
		settlementNote: undefined,
	};
	const settledDone = settledResult(
		registry,
		done,
		{ command: "pi", prompt: "Build.", runtime: "pi" },
		false,
	);
	const promotedDone = promotedResult(
		done,
		{ command: "pi", prompt: "Build.", runtime: "pi" },
		false,
	);
	assert.match(text(settledDone), /result notes: missing Evidence; empty Files/);
	assert.deepEqual(settledDone.details.resultNotes, done.resultNotes);
	assert.deepEqual(promotedDone.details.resultNotes, done.resultNotes);
});
