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

test("an idle session is woken with a new turn", async () => {
	const { sent, registry } = harness(true);
	const { record, completion } = registry.start({ kind: "run", command: "echo done", cwd });
	registry.markPromoted(record.id);
	await completion;
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.options?.triggerTurn, true);
	assert.equal(sent[0]?.customType, "detach_finished");
	assert.match(sent[0]?.content ?? "", /exit 0/);
	assert.match(sent[0]?.content ?? "", /done/);
});

test("a busy session is steered mid-turn instead", async () => {
	const { sent, registry } = harness(false);
	const { record, completion } = registry.start({ kind: "run", command: "echo done", cwd });
	registry.markPromoted(record.id);
	await completion;
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.options?.deliverAs, "steer");
	assert.notEqual(sent[0]?.options?.triggerTurn, true);
});

test("a run still awaited inline is not announced", async () => {
	const { sent, registry } = harness(true);
	const { completion } = registry.start({ kind: "run", command: "echo quiet", cwd });
	await completion;
	assert.equal(sent.length, 0);
});

test("a deliberately stopped run is not announced", async () => {
	const { sent, registry } = harness(true);
	const { record, completion } = registry.start({ kind: "watch", command: "sleep 30", cwd });
	registry.stop(record.id);
	await completion;
	assert.equal(sent.length, 0);
});

test("a watch that dies on its own is announced", async () => {
	const { sent, registry } = harness(true);
	const { completion } = registry.start({ kind: "watch", command: "exit 1", cwd });
	await completion;
	assert.equal(sent.length, 1);
	assert.match(sent[0]?.content ?? "", /exit 1/);
});

test("failures carry a longer tail than successes", async () => {
	const seed = "for i in $(seq 1 60); do echo line-$i; done";

	const ok = harness(true);
	const okRun = ok.registry.start({ kind: "run", command: seed, cwd });
	ok.registry.markPromoted(okRun.record.id);
	await okRun.completion;

	const bad = harness(true);
	const badRun = bad.registry.start({ kind: "run", command: `${seed}; exit 2`, cwd });
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
	const { record, completion } = registry.start({ kind: "run", command: "true", cwd });
	registry.markPromoted(record.id);
	await completion;
	assert.match(sent[0]?.content ?? "", /continue what you were doing/i);
	assert.match(sent[0]?.content ?? "", /bg_output/);
});
