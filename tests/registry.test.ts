import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createRegistry } from "../src/registry.ts";

const cwd = tmpdir();

test("captures output and exit code of a completed run", async () => {
	const registry = createRegistry();
	const { record, completion } = await registry.start({
		kind: "run",
		command: "echo hello-detach",
		cwd,
	});
	const finished = await completion;
	assert.equal(finished.id, record.id);
	assert.equal(finished.status, "exited");
	assert.equal(finished.exitCode, 0);
	assert.match(registry.tail(record.id, 10), /hello-detach/);
});

test("captures stderr and a non-zero exit code", async () => {
	const registry = createRegistry();
	const { record, completion } = await registry.start({
		kind: "run",
		command: "echo boom >&2; exit 3",
		cwd,
	});
	const finished = await completion;
	assert.equal(finished.exitCode, 3);
	assert.match(registry.tail(record.id, 10), /boom/);
});

test("dedupes an identical command in the same directory", async () => {
	const registry = createRegistry();
	const first = await registry.start({ kind: "watch", command: "sleep 5", cwd });
	const second = await registry.start({ kind: "watch", command: "sleep 5", cwd });
	assert.equal(second.deduped, true);
	assert.equal(second.record.id, first.record.id);
	registry.stop(first.record.id);
	await first.completion;
});

test("treats the same command in a different directory as a separate run", async () => {
	const registry = createRegistry();
	const first = await registry.start({ kind: "watch", command: "sleep 5", cwd });
	const second = await registry.start({ kind: "watch", command: "sleep 5", cwd: "/" });
	assert.equal(second.deduped, false);
	assert.notEqual(second.record.id, first.record.id);
	registry.stopAll();
	await Promise.all([first.completion, second.completion]);
});

test("stop terminates the process and marks it killed", async () => {
	const registry = createRegistry();
	const { record, completion } = await registry.start({ kind: "watch", command: "sleep 30", cwd });
	registry.stop(record.id);
	const finished = await completion;
	assert.equal(finished.status, "killed");
});

test("stop reaches child processes in the group", async () => {
	const registry = createRegistry();
	const { record, completion } = await registry.start({
		kind: "watch",
		command: "sleep 30 & sleep 30",
		cwd,
	});
	const pid = record.pid;
	assert.ok(pid);
	registry.stop(record.id);
	await completion;
	assert.throws(() => process.kill(-(pid as number), 0));
});

test("fires the exit handler once per run", async () => {
	const registry = createRegistry();
	const seen: string[] = [];
	registry.onExit((record) => seen.push(record.id));
	const first = await registry.start({ kind: "run", command: "true", cwd });
	const second = await registry.start({ kind: "run", command: "false", cwd });
	await Promise.all([first.completion, second.completion]);
	assert.deepEqual(seen.sort(), [first.record.id, second.record.id].sort());
});

test("reports error lines matching a watch pattern", async () => {
	const registry = createRegistry();
	const hits: string[] = [];
	registry.onErrorLine((_record, line) => hits.push(line));
	const { completion } = await registry.start({
		kind: "watch",
		command: "echo all good; echo 'ERROR: nope'",
		cwd,
		errorPattern: "error",
	});
	await completion;
	assert.equal(hits.length, 1);
	assert.match(hits[0] ?? "", /nope/);
});

test("readLog filters with grep and respects the line limit", async () => {
	const registry = createRegistry();
	const { record, completion } = await registry.start({
		kind: "run",
		command: "printf 'alpha\\nbeta\\ngamma\\n'",
		cwd,
	});
	await completion;
	const filtered = await registry.readLog(record.id, { lines: 100, grep: "^b" });
	assert.equal(filtered.trim(), "beta");
	const limited = await registry.readLog(record.id, { lines: 1 });
	assert.equal(limited.split("\n").filter(Boolean).length, 1);
});

test("survives a command that cannot be spawned", async () => {
	const registry = createRegistry();
	const { record, completion } = await registry.start({
		kind: "run",
		command: "definitely-not-a-real-binary-xyz",
		cwd,
	});
	const finished = await completion;
	assert.equal(finished.status, "exited");
	assert.notEqual(finished.exitCode, 0);
	assert.match(registry.tail(record.id, 20), /not found|No such file|not-a-real-binary/i);
});

test("lists runs with newest first", async () => {
	const registry = createRegistry();
	const first = await registry.start({ kind: "run", command: "true", cwd, label: "first" });
	await first.completion;
	await new Promise((r) => setTimeout(r, 5));
	const second = await registry.start({ kind: "run", command: "true", cwd, label: "second" });
	await second.completion;
	const listed = registry.list();
	assert.equal(listed[0]?.label, "second");
	assert.equal(listed.length, 2);
});

test("a done line notifies once and outranks the error pattern", async () => {
	const registry = createRegistry();
	const done: string[] = [];
	const errors: string[] = [];
	registry.onDoneLine((_record, line) => done.push(line));
	registry.onErrorLine((_record, line) => errors.push(line));
	const { completion } = await registry.start({
		kind: "watch",
		command: "echo waiting; echo 'Pipeline FAILED — terminal state'",
		cwd,
		donePattern: "terminal",
		errorPattern: "failed",
	});
	await completion;
	assert.deepEqual(errors, []);
	assert.equal(done.length, 1);
	assert.match(done[0] ?? "", /terminal state/);
});
