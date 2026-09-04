import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createNotifier } from "../src/notify.ts";
import { createRegistry } from "../src/registry.ts";
import type { RunRecord } from "../src/types.ts";

const cwd = tmpdir();

interface Sent {
	customType: string;
	content: string;
	options: { triggerTurn?: boolean; deliverAs?: string } | undefined;
}

function harness(idle: boolean) {
	const sent: Sent[] = [];
	const pi = {
		sendMessage(message: { customType: string; content: string }, options?: Sent["options"]) {
			sent.push({ customType: message.customType, content: message.content, options });
		},
	} as unknown as ExtensionAPI;
	const registry = createRegistry();
	const ctx = { isIdle: () => idle } as ExtensionContext;
	const notifier = createNotifier(pi, registry, () => ctx);
	registry.onExit((record) => notifier.runFinished(record));
	registry.onErrorLine((record, line) => notifier.watchErrorLine(record, line));
	return { sent, registry, notifier };
}

function settledAgent(closeOnSettle: boolean): RunRecord {
	return {
		id: closeOnSettle ? "auto-close" : "kept-alive",
		kind: "agent",
		command: "pi",
		cwd,
		label: "scout",
		status: "exited",
		backend: "herdr",
		paneId: "w1:p2",
		agentName: "scout-worker",
		agentState: "idle",
		closeOnSettle,
		exitCode: 0,
		startedAt: Date.now() - 100,
		endedAt: Date.now(),
		promoted: true,
		logPath: "",
	};
}

test("an idle session is woken with a new turn", async () => {
	const { sent, registry } = harness(true);
	const { record, completion } = await registry.start({ kind: "run", command: "echo done", cwd });
	registry.markPromoted(record.id);
	await completion;
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.options?.triggerTurn, true);
	assert.equal(sent[0]?.customType, "detach_finished");
	assert.match(sent[0]?.content ?? "", /exit 0/);
	assert.match(sent[0]?.content ?? "", /done/);
});

test("a quiet promoted run never reaches the viewer hook", async () => {
	const promotions: string[] = [];
	const registry = createRegistry({ onPromoted: (record) => promotions.push(record.id) });
	const loud = await registry.start({ kind: "run", command: "sleep 0.05", cwd });
	registry.markPromoted(loud.record.id);
	const quiet = await registry.start({ kind: "run", command: "sleep 0.06", cwd, quiet: true });
	registry.markPromoted(quiet.record.id);
	assert.deepEqual(promotions, [loud.record.id], "only the loud run is surfaced");
	await Promise.all([loud.completion, quiet.completion]);
});

test("a busy session is steered mid-turn instead", async () => {
	const { sent, registry } = harness(false);
	const { record, completion } = await registry.start({ kind: "run", command: "echo done", cwd });
	registry.markPromoted(record.id);
	await completion;
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.options?.deliverAs, "steer");
	assert.notEqual(sent[0]?.options?.triggerTurn, true);
});

test("a run still awaited inline is not announced", async () => {
	const { sent, registry } = harness(true);
	const { completion } = await registry.start({ kind: "run", command: "echo quiet", cwd });
	await completion;
	assert.equal(sent.length, 0);
});

test("a deliberately stopped run is not announced", async () => {
	const { sent, registry } = harness(true);
	const { record, completion } = await registry.start({ kind: "watch", command: "sleep 30", cwd });
	registry.stop(record.id);
	await completion;
	assert.equal(sent.length, 0);
});

test("a watch that dies on its own is announced", async () => {
	const { sent, registry } = harness(true);
	const { completion } = await registry.start({ kind: "watch", command: "exit 1", cwd });
	await completion;
	assert.equal(sent.length, 1);
	assert.match(sent[0]?.content ?? "", /exit 1/);
});

test("failures carry a longer tail than successes", async () => {
	const seed = "for i in $(seq 1 60); do echo line-$i; done";

	const ok = harness(true);
	const okRun = await ok.registry.start({ kind: "run", command: seed, cwd });
	ok.registry.markPromoted(okRun.record.id);
	await okRun.completion;

	const bad = harness(true);
	const badRun = await bad.registry.start({ kind: "run", command: `${seed}; exit 2`, cwd });
	bad.registry.markPromoted(badRun.record.id);
	await badRun.completion;

	const okLines = (ok.sent[0]?.content ?? "").split("\n").length;
	const badLines = (bad.sent[0]?.content ?? "").split("\n").length;
	assert.ok(badLines > okLines, `expected failure tail ${badLines} > success tail ${okLines}`);
});

test("watch error lines are rate limited", () => {
	const { sent, notifier } = harness(true);
	const record = { id: "abc", label: "dev", status: "running" } as RunRecord;
	notifier.watchErrorLine(record, "ERROR: first");
	notifier.watchErrorLine(record, "ERROR: second");
	assert.equal(sent.length, 1);
	assert.match(sent[0]?.content ?? "", /first/);
	assert.equal(sent[0]?.customType, "detach_watch_error");
});

test("the completion message tells the agent to keep going", async () => {
	const { sent, registry } = harness(true);
	const { record, completion } = await registry.start({ kind: "run", command: "true", cwd });
	registry.markPromoted(record.id);
	await completion;
	assert.match(sent[0]?.content ?? "", /continue what you were doing/i);
	assert.match(sent[0]?.content ?? "", /bg_output/);
});

test("an auto-closing agent notice tells the model to launch fresh", () => {
	const { sent, notifier } = harness(true);
	notifier.runFinished(settledAgent(true));
	const content = sent[0]?.content ?? "";
	assert.match(content, /tab is being closed automatically/i);
	assert.match(content, /launch a fresh agent/i);
	assert.doesNotMatch(content, /agent is still alive/i);
	assert.doesNotMatch(content, /bg_agent\(\{ name:/);
});

test("a kept-alive agent notice permits a name-based follow-up", () => {
	const { sent, notifier } = harness(true);
	notifier.runFinished(settledAgent(false));
	const content = sent[0]?.content ?? "";
	assert.match(content, /bg_agent\(\{ name: "scout-worker"/);
	assert.match(content, /tab was kept available/i);
	assert.doesNotMatch(content, /launch a fresh agent/i);
});

test("agent settlement headline carries result Status and artifact path", () => {
	const { sent, notifier } = harness(true);
	const record = settledAgent(false);
	record.resultStatus = "BLOCKED: needs approval";
	record.resultPath = "/tmp/result.md";
	record.agentState = "blocked";
	notifier.runFinished(record);
	assert.match(sent[0]?.content ?? "", /result Status: BLOCKED: needs approval/);
	assert.match(sent[0]?.content ?? "", /Result artifact: \/tmp\/result\.md/);
});

test("Regression: a stalled settlement names its cause instead of the generic prompt-not-registered label", () => {
	// Failure mode: every stalled state printed "did not visibly start working", even
	// when the agent had finished its work and only its result artifact failed
	// validation. Parents then distrusted complete results and relaunched.
	const { sent, notifier } = harness(true);
	const record = settledAgent(false);
	record.agentState = "stalled";
	record.settlementNote = "required result artifact is invalid: /tmp/result.md has empty sections: Claims";
	record.resultPath = "/tmp/result.md";
	notifier.runFinished(record);
	const content = sent[0]?.content ?? "";
	assert.match(content, /settled as stalled — required result artifact is invalid: .*empty sections: Claims/);
	assert.doesNotMatch(content, /did not visibly start working/);
	assert.match(content, /underlying work may be complete/);
	assert.match(content, /repair only the artifact/);

	const generic = harness(true);
	const plain = settledAgent(false);
	plain.agentState = "stalled";
	generic.notifier.runFinished(plain);
	assert.match(generic.sent[0]?.content ?? "", /did not visibly start working/);
});

test("paused agent notice is delivered once with supervision guidance", () => {
	const { sent, notifier } = harness(false);
	const record = settledAgent(false);
	record.status = "running";
	record.resultStatus = "IN PROGRESS — waiting for checks";
	record.resultPath = "/tmp/result.md";
	notifier.agentPaused(record, "waiting on its own sub-agent(s): child-scout");
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.customType, "detach_agent_paused");
	assert.equal(sent[0]?.options?.deliverAs, "steer");
	assert.match(sent[0]?.content ?? "", /paused after a turn/);
	assert.match(sent[0]?.content ?? "", /supervision continues/);
	assert.match(sent[0]?.content ?? "", /waiting on its own sub-agent\(s\): child-scout/);
	assert.match(sent[0]?.content ?? "", /Status line is stale/);
	assert.match(sent[0]?.content ?? "", /result Status: "IN PROGRESS — waiting for checks"/);
	assert.match(sent[0]?.content ?? "", /Result artifact: \/tmp\/result\.md/);
	assert.match(sent[0]?.content ?? "", /continue what you were doing/i);
});
