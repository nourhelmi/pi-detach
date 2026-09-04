import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBbDriver } from "../src/bb/driver.ts";
import { BbClientError, type BbClient } from "../src/bb/client.ts";
import type { DriverOutcome, RunRecord } from "../src/types.ts";

const result = (status: string) => `## Status\n${status}\n## Claims\nx\n## Evidence\nx\n## Files\nx\n## Decisions\nx\n## Remaining Risk\nx\n`;
test("BLOCKED pauses and continuation retains run/thread before terminal finish", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bb-driver-")); const resultPath = join(dir, "result.md"); await writeFile(resultPath, result("BLOCKED"));
  const starts: Array<Record<string, unknown>> = []; const waits: Array<(value: any) => void> = [];
  const client: BbClient = {
    async start(input) { starts.push(input); return { version: "1", runId: input.runId, threadId: "thread-one", logicalParentThreadId: input.logicalParentThreadId, hostId: input.hostId, projectId: input.projectId, environmentId: "worker-env", providerId: "pi", model: input.model, reasoning: input.reasoning, cwd: input.cwd }; },
    wait() { return new Promise((resolve) => waits.push(resolve)); },
    async stop() { return { version: "1", stopped: true }; }, async authorizeWake() { return { version: "1", state: "sent" }; },
  };
  const record: RunRecord = { id: "run-one", kind: "agent", command: "pi", cwd: dir, label: "builder", status: "running", backend: "bb", startedAt: 0, promoted: true, logPath: join(dir, "output.log"), resultPath };
	let pauses = 0; let outcome: DriverOutcome | undefined;
	let signalPaused!: () => void;
	const paused = new Promise<void>((resolve) => { signalPaused = resolve; });
	let signalFinished!: () => void;
	const finished = new Promise<void>((resolve) => { signalFinished = resolve; });
	const handle = await createBbDriver({ client, context: { threadId: "parent", projectId: "project", environmentId: "parent-env", serverUrl: "http://127.0.0.1" }, hostId: "host" })({ kind: "agent", command: "pi", cwd: dir, label: "builder", requiredArtifactPath: resultPath, piLaunchSpec: { provider: "openai", model: "gpt", reasoning: "high", prompt: "work", role: "builder", maxTurns: 6, allowSubagents: false, resultPath } }, { record, emitOutput() {}, progress() {}, pause(value) { pauses += 1; record.agentState = value.agentState; signalPaused(); }, async resume() { record.agentState = undefined; }, finish(value) { outcome = value; signalFinished(); } });
	waits.shift()?.({ version: "1", runId: "run-one", threadId: "thread-one", transportState: "idle", logicalDescendants: "none" }); await paused; assert.equal(pauses, 1);
	await assert.rejects(handle.continue!("WRONG"), /BB-POC-CONTINUE/);
	const continuing = handle.continue!("BB-POC-CONTINUE"); assert.equal(starts[1]?.continuation, true); assert.equal(starts[1]?.runId, "run-one");
	waits.shift()?.({ version: "1", runId: "run-one", threadId: "thread-one", transportState: "active", logicalDescendants: "none" }); await continuing;
	await writeFile(resultPath, result("PASS")); waits.shift()?.({ version: "1", runId: "run-one", threadId: "thread-one", transportState: "idle", logicalDescendants: "none" }); await finished; assert.equal(outcome?.agentState, "done");
});

test("retries an ambiguous idempotent start and re-arms threads.wait after plugin reload", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bb-driver-reload-"));
	const resultPath = join(dir, "result.md");
	await writeFile(resultPath, result("PASS"));
	let starts = 0;
	let waits = 0;
	const client: BbClient = {
		async start(input) {
			starts += 1;
			if (starts === 1) throw new BbClientError("network", "connection reset after spawn");
			return { version: "1", runId: input.runId, threadId: "thread-reload", logicalParentThreadId: input.logicalParentThreadId, hostId: input.hostId, projectId: input.projectId, environmentId: "worker-env", providerId: "pi", model: input.model, reasoning: input.reasoning, cwd: input.cwd };
		},
		async wait(input) {
			waits += 1;
			if (waits === 1) throw new BbClientError("http", "plugin reload disposed an in-flight wait", 500);
			return { version: "1", runId: input.runId, threadId: input.threadId, transportState: "idle", logicalDescendants: "none" };
		},
		async stop() { return { version: "1", stopped: true }; },
		async authorizeWake() { return { version: "1", state: "sent" }; },
	};
	const record: RunRecord = { id: "run-reload", kind: "agent", command: "pi", cwd: dir, label: "checker", status: "running", backend: "bb", startedAt: 0, promoted: true, logPath: join(dir, "output.log"), resultPath };
	const progress: string[] = [];
	let outcome: DriverOutcome | undefined;
	let settle!: () => void;
	const finished = new Promise<void>((resolve) => { settle = resolve; });
	await createBbDriver({ client, context: { threadId: "parent", projectId: "project", environmentId: "parent-env", serverUrl: "http://127.0.0.1" }, hostId: "host", reconnectDelayMs: 0, startAttempts: 2 })(
		{ kind: "agent", command: "pi", cwd: dir, label: "checker", requiredArtifactPath: resultPath, piLaunchSpec: { provider: "openai", model: "gpt", reasoning: "high", prompt: "work", role: "checker", maxTurns: 5, allowSubagents: false, resultPath } },
		{ record, emitOutput() {}, progress(note) { progress.push(note); }, pause() {}, async resume() {}, finish(value) { outcome = value; settle(); } },
	);
	await finished;
	assert.equal(starts, 2);
	assert.equal(waits, 2);
	assert.equal(outcome?.agentState, "done");
	assert.deepEqual(progress, [
		"BB start response disconnected; retrying the idempotent run ID",
		"BB threads.wait disconnected; re-arming the same event-driven wait",
	]);
});
