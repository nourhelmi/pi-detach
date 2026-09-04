import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBbDriver } from "../src/bb/driver.ts";
import type { BbClient } from "../src/bb/client.ts";
import { createRegistry } from "../src/registry.ts";
import {
	type RunLifecycleRevision,
	type RunStateWriter,
	writeRunState,
} from "../src/run-state.ts";
import type { DriverStart, RunController, StartOptions } from "../src/types.ts";

const artifact = (status: string) => `# Status
${status}
# Claims
complete
# Evidence
complete
# Files
complete
# Decisions
complete
# Remaining Risk
none
`;

const context = {
	threadId: "parent-thread",
	projectId: "project-one",
	environmentId: "parent-environment",
	serverUrl: "http://127.0.0.1",
} as const;

function startOptions(directory: string, resultPath: string): StartOptions {
	return {
		kind: "agent",
		command: "pi --mode rpc",
		cwd: directory,
		label: "fast-worker",
		requiredArtifactPath: resultPath,
		piLaunchSpec: {
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			reasoning: "high",
			prompt: "settle immediately",
			role: "builder",
			maxTurns: 6,
			allowSubagents: false,
			resultPath,
		},
	};
}

function fastClient(resultPath: string, status: "BLOCKED" | "PASS") {
	let starts = 0;
	let waits = 0;
	const client: BbClient = {
		async start(input) {
			starts += 1;
			if (!input.continuation) await writeFile(resultPath, artifact(status));
			return {
				version: "1",
				runId: input.runId,
				threadId: "fast-thread",
				logicalParentThreadId: input.logicalParentThreadId,
				hostId: input.hostId,
				projectId: input.projectId,
				environmentId: "worker-environment",
				providerId: "pi",
				model: input.model,
				reasoning: input.reasoning,
				cwd: input.cwd,
			};
		},
		async wait(input, signal) {
			waits += 1;
			if (waits === 1) {
				return {
					version: "1",
					runId: input.runId,
					threadId: input.threadId,
					transportState: "idle",
					logicalDescendants: "none",
				};
			}
			return await new Promise<never>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new Error("wait aborted")), { once: true });
			});
		},
		async stop() {
			return { version: "1", stopped: true };
		},
		async authorizeWake() {
			return { version: "1", state: "sent" };
		},
	};
	return { client, startCount: () => starts };
}

function holdHandleUntil(
	driver: DriverStart,
	expected: "paused" | "finished",
): DriverStart {
	return async (options, controller) => {
		let resolveTransition!: () => void;
		let rejectTransition!: (error: Error) => void;
		const transition = new Promise<void>((resolve, reject) => {
			resolveTransition = resolve;
			rejectTransition = reject;
		});
		const timeout = setTimeout(
			() => rejectTransition(new Error(`BB driver did not report early ${expected}`)),
			2_000,
		);
		const observed: RunController = {
			...controller,
			pause(outcome) {
				controller.pause(outcome);
				if (expected === "paused") resolveTransition();
			},
			finish(outcome) {
				controller.finish(outcome);
				if (expected === "finished") resolveTransition();
			},
		};
		try {
			const handle = await driver(options, observed);
			await transition;
			return handle;
		} finally {
			clearTimeout(timeout);
		}
	};
}

interface ObservedWrite {
	lifecycle: RunLifecycleRevision;
	status: string;
	agentState?: string;
}

function recordingWriter(
	writes: ObservedWrite[],
	failure?: Error,
): RunStateWriter {
	return async (record, lifecycle, path) => {
		writes.push({
			lifecycle: { ...lifecycle },
			status: record.status,
			...(record.agentState ? { agentState: record.agentState } : {}),
		});
		if (failure) throw failure;
		await writeRunState(record, lifecycle, path);
	};
}

function integratedDriver(client: BbClient, expected: "paused" | "finished"): DriverStart {
	return holdHandleUntil(
		createBbDriver({ client, context, hostId: "host-one", reconnectDelayMs: 0 }),
		expected,
	);
}

test("real Registry + BB driver preserves an early synchronous BLOCKED projection", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "bb-registry-pause-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const resultPath = join(directory, "result.md");
	const statePath = join(directory, "state.json");
	const { client, startCount } = fastClient(resultPath, "BLOCKED");
	const writes: ObservedWrite[] = [];
	const registry = createRegistry({
		agentDriver: { backend: "bb", start: integratedDriver(client, "paused") },
		runStatePath: () => statePath,
		runStateWriter: recordingWriter(writes),
	});
	const started = await registry.start(startOptions(directory, resultPath));
	try {
		assert.equal(started.record.agentState, "blocked");
		assert.equal(started.record.surface?.kind, "bb");
		assert.equal(started.record.surface?.kind === "bb" ? started.record.surface.threadId : undefined, "fast-thread");
		await assert.rejects(registry.continue(started.record.id, "WRONG"), /BB-POC-CONTINUE/);
		assert.equal(startCount(), 1);
		assert.deepEqual(writes, [{ lifecycle: { revision: 1, transportState: "paused" }, status: "running", agentState: "blocked" }]);
		const durable = JSON.parse(await readFile(statePath, "utf8"));
		assert.equal(durable.transportState, "paused");
		assert.equal(durable.lifecycleRevision, 1);
		assert.equal(durable.settlementDecision, "pause");
		assert.equal(durable.agentState, "blocked");
		assert.equal(durable.surface.threadId, "fast-thread");
	} finally {
		registry.stop(started.record.id);
		await started.completion;
	}
});

test("real Registry + BB driver preserves an early synchronous terminal projection", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "bb-registry-finish-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const resultPath = join(directory, "result.md");
	const statePath = join(directory, "state.json");
	const { client } = fastClient(resultPath, "PASS");
	const writes: ObservedWrite[] = [];
	const registry = createRegistry({
		agentDriver: { backend: "bb", start: integratedDriver(client, "finished") },
		runStatePath: () => statePath,
		runStateWriter: recordingWriter(writes),
	});
	const started = await registry.start(startOptions(directory, resultPath));
	const finished = await started.completion;
	assert.equal(finished.status, "exited");
	assert.equal(finished.agentState, "done");
	assert.equal(finished.surface?.kind === "bb" ? finished.surface.threadId : undefined, "fast-thread");
	assert.deepEqual(writes, [{ lifecycle: { revision: 1, transportState: "finished" }, status: "exited", agentState: "done" }]);
	const durable = JSON.parse(await readFile(statePath, "utf8"));
	assert.equal(durable.transportState, "finished");
	assert.equal(durable.lifecycleRevision, 1);
	assert.equal(durable.settlementDecision, "finish");
	assert.equal(durable.status, "exited");
	assert.equal(durable.agentState, "done");
	assert.equal(durable.surface.threadId, "fast-thread");
});

test("an early BLOCKED persistence failure prevents continuation instead of masking itself", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "bb-registry-pause-failure-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const resultPath = join(directory, "result.md");
	const statePath = join(directory, "state.json");
	const { client, startCount } = fastClient(resultPath, "BLOCKED");
	const writes: ObservedWrite[] = [];
	const registry = createRegistry({
		agentDriver: { backend: "bb", start: integratedDriver(client, "paused") },
		runStatePath: () => statePath,
		runStateWriter: recordingWriter(writes, new Error("projection write denied")),
	});
	const started = await registry.start(startOptions(directory, resultPath));
	try {
		await assert.rejects(
			registry.continue(started.record.id, "BB-POC-CONTINUE"),
			/projection write denied/,
		);
		assert.equal(startCount(), 1);
		assert.deepEqual(writes, [{ lifecycle: { revision: 1, transportState: "paused" }, status: "running", agentState: "blocked" }]);
		await assert.rejects(readFile(statePath, "utf8"), { code: "ENOENT" });
	} finally {
		registry.stop(started.record.id);
		const finished = await started.completion;
		assert.equal(finished.agentState, "stalled");
		assert.match(finished.resultStatus ?? "", /could not persist canonical run projection/);
	}
});

test("an early terminal persistence failure leaves no wake-authorizing projection", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "bb-registry-finish-failure-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const resultPath = join(directory, "result.md");
	const statePath = join(directory, "state.json");
	const { client } = fastClient(resultPath, "PASS");
	const writes: ObservedWrite[] = [];
	const registry = createRegistry({
		agentDriver: { backend: "bb", start: integratedDriver(client, "finished") },
		runStatePath: () => statePath,
		runStateWriter: recordingWriter(writes, new Error("projection write denied")),
	});
	const started = await registry.start(startOptions(directory, resultPath));
	const finished = await started.completion;
	assert.equal(finished.status, "exited");
	assert.equal(finished.agentState, "stalled");
	assert.match(finished.resultStatus ?? "", /could not persist canonical run projection: projection write denied/);
	assert.deepEqual(writes, [{ lifecycle: { revision: 1, transportState: "finished" }, status: "exited", agentState: "done" }]);
	await assert.rejects(readFile(statePath, "utf8"), { code: "ENOENT" });
});
