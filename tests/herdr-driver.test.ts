import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CliResult, HerdrCli, Waiter } from "../src/herdr/cli.ts";
import { createHerdrDriver, parseResultArtifactStatus, settlementArtifactIssue } from "../src/herdr/driver.ts";
import { createSessionLedger } from "../src/herdr/ledger.ts";
import { createPaneManager } from "../src/herdr/panes.ts";
import { startMarker } from "../src/herdr/sentinel.ts";
import { createViewerManager } from "../src/herdr/viewer.ts";
import { createRegistry } from "../src/registry.ts";

const cwd = tmpdir();

const ok = (json: unknown, stdout = ""): CliResult => ({
	ok: true,
	code: 0,
	stdout,
	stderr: "",
	json,
});

const failed = (errorCode: string, message = errorCode): CliResult => ({
	ok: false,
	code: 1,
	stdout: "",
	stderr: "",
	json: { error: { code: errorCode, message } },
	errorCode,
	errorMessage: message,
});

interface FakeWaiter extends Waiter {
	args: string[];
	resolveWith(result: CliResult): void;
	killedByDriver: boolean;
}

/** Scriptable herdr CLI: canned exec responses plus externally-resolved waits. */
function createFakeCli(): {
	cli: HerdrCli;
	execCalls: string[][];
	execTimeouts: Array<number | undefined>;
	waiters: FakeWaiter[];
	respond: (prefix: string, handler: (args: string[]) => CliResult | Promise<CliResult>) => void;
} {
	const execCalls: string[][] = [];
	const execTimeouts: Array<number | undefined> = [];
	const waiters: FakeWaiter[] = [];
	const routes: { prefix: string; handler: (args: string[]) => CliResult | Promise<CliResult> }[] = [];
	let paneCounter = 1;

	const defaults: typeof routes = [
		{
			prefix: "pane layout",
			handler: () =>
				ok({
					result: {
						layout: {
							panes: [{ pane_id: "w1:p1", rect: { width: 120, height: 30 } }],
						},
					},
				}),
		},
		{
			prefix: "pane split",
			handler: () => {
				paneCounter += 1;
				return ok({ result: { pane: { pane_id: `w1:p${paneCounter}` }, type: "pane_info" } });
			},
		},
		{
			prefix: "tab create",
			handler: () => {
				paneCounter += 1;
				return ok({
					result: {
						root_pane: { pane_id: `w1:p${paneCounter}` },
						tab: { tab_id: "w1:t9" },
						type: "tab_created",
					},
				});
			},
		},
		{ prefix: "pane rename", handler: () => ok({ result: { type: "pane_info" } }) },
		{ prefix: "pane run", handler: () => ok(undefined) },
		{ prefix: "agent prompt", handler: () => ok({ result: { type: "agent_prompted" } }) },
		{ prefix: "pane send-keys", handler: () => ok({ result: { type: "ok" } }) },
		{ prefix: "pane read", handler: () => ok(undefined, "") },
		{ prefix: "pane close", handler: () => ok({ result: { type: "ok" } }) },
		{ prefix: "notification show", handler: () => ok({ result: { shown: false } }) },
		{
			prefix: "pane process-info",
			handler: () =>
				ok({
					result: {
						process_info: { foreground_processes: [{ name: "zsh", argv0: "zsh" }] },
					},
				}),
		},
	];

	const cli: HerdrCli = {
		exec(args, opts) {
			execCalls.push(args);
			execTimeouts.push(opts?.timeoutMs);
			const key = args.join(" ");
			for (const route of [...routes, ...defaults]) {
				if (key.startsWith(route.prefix)) return Promise.resolve(route.handler(args));
			}
			return Promise.resolve(failed("not_scripted", key));
		},
		spawnWaiter(args) {
			let resolvePromise!: (result: CliResult) => void;
			const promise = new Promise<CliResult>((r) => {
				resolvePromise = r;
			});
			const waiter: FakeWaiter = {
				args,
				promise,
				killedByDriver: false,
				kill() {
					this.killedByDriver = true;
					resolvePromise(failed("cancelled"));
				},
				resolveWith(result) {
					resolvePromise(result);
				},
			};
			waiters.push(waiter);
			return waiter;
		},
	};

	return {
		cli,
		execCalls,
		execTimeouts,
		waiters,
		respond: (prefix, handler) => routes.push({ prefix, handler }),
	};
}

function agentGet(paneId: string, name: string, agent_status: string, state_change_seq = 1): CliResult {
	return ok({
		result: {
			agent: { pane_id: paneId, name, agent_status, state_change_seq },
			type: "agent_info",
		},
	});
}

function resultArtifact(status: string): string {
	return `# Status\n${status}\n# Claims\nBuilt\n# Evidence\nTests pass\n# Files\n- src/x.ts\n# Decisions\nNone\n# Remaining Risk\nNone\n`;
}

function closedPanes(execCalls: string[][]): string[] {
	return execCalls.filter((args) => args[0] === "pane" && args[1] === "close").map((args) => args[2] ?? "");
}

function herdrRegistry(
	fake: ReturnType<typeof createFakeCli>,
	extras: {
		ledger?: ReturnType<typeof createSessionLedger>;
		reapOrphans?: () => Promise<void>;
		env?: Record<string, string>;
	} = {},
) {
	const ctx = { paneId: "w1:p1", tabId: "w1:t7", workspaceId: "w1" };
	const panes = createPaneManager(fake.cli, ctx);
	const driver = createHerdrDriver({
		cli: fake.cli,
		ctx,
		panes,
		env: { PI_DETACH_HERDR_TOAST: "0", ...extras.env },
		...(extras.ledger ? { ledger: extras.ledger } : {}),
		...(extras.reapOrphans ? { reapOrphans: extras.reapOrphans } : {}),
	});
	const viewer = createViewerManager(fake.cli, panes);
	return createRegistry({ herdrDriver: driver, onPromoted: viewer.attach });
}

function flushAsync(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("condition did not become true before timeout");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function waitOutcome(id: string, exitCode: number, body: string): CliResult {
	const text = [
		startMarker(id),
		body,
		`<<pi-detach:${id}:${exitCode}>>`,
		"➜  repo",
	].join("\n");
	return ok({
		result: {
			matched_line: `<<pi-detach:${id}:${exitCode}>>`,
			read: { text },
			type: "output_matched",
		},
	});
}

function splitCalls(execCalls: string[][]): string[][] {
	return execCalls.filter((args) => args[0] === "pane" && args[1] === "split");
}

function splitDirection(args: string[] | undefined): string | undefined {
	if (!args) return undefined;
	const index = args.indexOf("--direction");
	return index >= 0 ? args[index + 1] : undefined;
}

function idleShell(): CliResult {
	return ok({
		result: {
			process_info: { foreground_processes: [{ name: "zsh", argv0: "zsh" }] },
		},
	});
}

function paneManagerOf(fake: ReturnType<typeof createFakeCli>) {
	const ctx = { paneId: "w1:p1", tabId: "w1:t7", workspaceId: "w1" };
	return { ctx, panes: createPaneManager(fake.cli, ctx) };
}


test("bg_run stays local and invisible even inside herdr", async () => {
	const fake = createFakeCli();
	const registry = herdrRegistry(fake);
	const { record, completion } = await registry.start({
		kind: "run",
		command: "echo fast-and-quiet",
		cwd,
	});
	assert.equal(record.backend, "local");
	const finished = await completion;
	assert.equal(finished.exitCode, 0);
	assert.equal(finished.paneId, undefined);
	assert.equal(fake.execCalls.length, 0, "no herdr calls for a foreground run");
	assert.match(registry.tail(record.id, 5), /fast-and-quiet/);
});

test("a promoted run gets a viewer pane that closes itself on success", async () => {
	const fake = createFakeCli();
	const registry = herdrRegistry(fake);
	const { record, completion } = await registry.start({
		kind: "run",
		command: "echo viewer-ok; sleep 0.8",
		cwd,
		label: "slow build",
	});
	registry.markPromoted(record.id);
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(record.paneId, "w1:p2", "viewer pane attached");
	const tailRun = fake.execCalls.find((args) => args[0] === "pane" && args[1] === "run");
	assert.match(tailRun?.[3] ?? "", /tail -n \+1 -f/);
	assert.match(tailRun?.[3] ?? "", new RegExp(record.id));
	const runningLabel = fake.execCalls.find(
		(args) => args[0] === "pane" && args[1] === "rename" && args[3] === "▶ slow build",
	);
	assert.ok(runningLabel, "viewer pane label omits run-id noise");

	await completion;
	await new Promise((r) => setTimeout(r, 600));
	assert.ok(
		fake.execCalls.some((args) => args[0] === "pane" && args[1] === "close"),
		"viewer pane closed after success",
	);
	assert.equal(record.paneId, undefined, "closed pane is no longer referenced");
});

test("a promoted run that fails keeps its viewer pane for inspection", async () => {
	const fake = createFakeCli();
	const registry = herdrRegistry(fake);
	const { record, completion } = await registry.start({
		kind: "run",
		command: "echo bad; sleep 0.5; exit 3",
		cwd,
		label: "failing tests",
	});
	registry.markPromoted(record.id);
	await completion;
	await new Promise((r) => setTimeout(r, 600));
	assert.ok(!fake.execCalls.some((args) => args[0] === "pane" && args[1] === "close"));
	assert.equal(record.paneId, "w1:p2");
	const rename = fake.execCalls.filter((args) => args[0] === "pane" && args[1] === "rename").at(-1);
	assert.match(rename?.[3] ?? "", /^✗ failing tests/);
	assert.doesNotMatch(rename?.[3] ?? "", new RegExp(record.id));
});

test("a run promoted after finishing gets no viewer pane", async () => {
	const fake = createFakeCli();
	const registry = herdrRegistry(fake);
	const { record, completion } = await registry.start({ kind: "run", command: "true", cwd });
	await completion;
	registry.markPromoted(record.id);
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(fake.execCalls.length, 0);
});

test("a watch is pane-hosted and completes through the sentinel wait", async () => {
	const fake = createFakeCli();
	const registry = herdrRegistry(fake);
	const { record, completion } = await registry.start({
		kind: "watch",
		command: "bun dev",
		cwd,
		label: "web dev",
	});
	assert.equal(record.backend, "herdr");
	assert.equal(record.paneId, "w1:p2");

	const paneRun = fake.execCalls.find((args) => args[0] === "pane" && args[1] === "run");
	assert.match(paneRun?.[3] ?? "", /bun dev/);
	assert.match(paneRun?.[3] ?? "", new RegExp(`<<pi-detach:${record.id}:start>>`));

	const waiter = fake.waiters.find((w) => w.args[0] === "pane" && w.args[1] === "wait-output");
	assert.ok(waiter, "spawned a blocking output wait");
	waiter?.resolveWith(waitOutcome(record.id, 1, "EADDRINUSE: port taken"));

	const finished = await completion;
	assert.equal(finished.status, "exited");
	assert.equal(finished.exitCode, 1);
	assert.match(registry.tail(record.id, 10), /EADDRINUSE/);
});

test("a watch re-arms supervision after a transient waiter failure", async () => {
	const fake = createFakeCli();
	const registry = herdrRegistry(fake);
	const { record, completion } = await registry.start({
		kind: "watch",
		command: "bun dev",
		cwd,
		label: "web dev",
	});

	fake.waiters[0]?.resolveWith(failed("server_unavailable", "herdr restarted"));
	await flushAsync();
	assert.equal(record.status, "running", "transport failure is not command settlement");

	await waitUntil(() => fake.waiters.length === 2);
	fake.waiters[1]?.resolveWith(waitOutcome(record.id, 0, "ready after reconnect"));

	const finished = await completion;
	assert.equal(finished.status, "exited");
	assert.equal(finished.exitCode, 0);
	assert.match(registry.tail(record.id, 10), /ready after reconnect/);
	assert.doesNotMatch(registry.tail(record.id, 10), /herdr wait failed/);
});

test("waiter recovery preserves a completed watch's exit code from the pane", async () => {
	const fake = createFakeCli();
	let snapshot = "";
	fake.respond("pane read", () => ok(undefined, snapshot));
	const registry = herdrRegistry(fake);
	const { record, completion } = await registry.start({ kind: "watch", command: "echo done", cwd });
	snapshot = [startMarker(record.id), "done", `<<pi-detach:${record.id}:7>>`, "➜  repo"].join("\n");

	fake.waiters[0]?.resolveWith(failed("server_unavailable"));
	const finished = await completion;

	assert.equal(finished.status, "exited");
	assert.equal(finished.exitCode, 7);
	assert.match(registry.tail(record.id, 10), /done/);
	assert.equal(fake.waiters.length, 1, "snapshot reconciliation cancels the pending retry");
});

test("a malformed successful wait response is retried instead of accepted", async () => {
	const fake = createFakeCli();
	const registry = herdrRegistry(fake);
	const { record, completion } = await registry.start({ kind: "watch", command: "bun dev", cwd });

	fake.waiters[0]?.resolveWith(ok({ result: { type: "output_matched" } }));
	await flushAsync();
	assert.equal(record.status, "running");

	await waitUntil(() => fake.waiters.length === 2);
	fake.waiters[1]?.resolveWith(waitOutcome(record.id, 0, "valid sentinel"));
	const finished = await completion;
	assert.equal(finished.status, "exited");
	assert.equal(finished.exitCode, 0);
});

test("shutdown detach cancels waiter recovery without interrupting the watch", async () => {
	const fake = createFakeCli();
	const registry = herdrRegistry(fake);
	const { record, completion } = await registry.start({ kind: "watch", command: "bun dev", cwd });
	let settled = false;
	void completion.then(() => {
		settled = true;
	});

	fake.waiters[0]?.resolveWith(failed("server_unavailable"));
	await flushAsync();
	registry.stopAll("shutdown");
	await new Promise((resolve) => setTimeout(resolve, 300));

	assert.equal(record.status, "running", "shutdown leaves the pane-owned command alive");
	assert.equal(settled, false);
	assert.equal(fake.waiters.length, 1, "shutdown prevents a replacement waiter");
	assert.equal(
		fake.execCalls.filter((args) => args[0] === "pane" && args[1] === "send-keys").length,
		0,
		"shutdown does not interrupt the pane",
	);
});

test("stopping a watch cancels a pending waiter retry", async () => {
	const fake = createFakeCli();
	const registry = herdrRegistry(fake);
	const { record, completion } = await registry.start({ kind: "watch", command: "bun dev", cwd });

	fake.waiters[0]?.resolveWith(failed("server_unavailable"));
	await waitUntil(() => fake.waiters.length === 2);
	fake.waiters[1]?.resolveWith(failed("server_unavailable"));
	await flushAsync();
	registry.stop(record.id);

	const finished = await completion;
	assert.equal(finished.status, "killed");
	assert.equal(fake.waiters.length, 2, "stop prevents another waiter from being spawned");
});

test("a second watch reuses the dead watch's pane and prepends cd", async () => {
	const fake = createFakeCli();
	const registry = herdrRegistry(fake);
	const first = await registry.start({ kind: "watch", command: "bun dev", cwd });
	fake.waiters[0]?.resolveWith(waitOutcome(first.record.id, 0, ""));
	await first.completion;

	const second = await registry.start({ kind: "watch", command: "bun preview", cwd: "/somewhere" });
	assert.equal(second.record.paneId, first.record.paneId);
	const splits = fake.execCalls.filter((args) => args[0] === "pane" && args[1] === "split");
	assert.equal(splits.length, 1, "no second split for the reused pane");
	const paneRuns = fake.execCalls.filter((args) => args[0] === "pane" && args[1] === "run");
	assert.match(paneRuns[1]?.[3] ?? "", /cd '\/somewhere' && bun preview/);
	fake.waiters[1]?.resolveWith(waitOutcome(second.record.id, 0, ""));
	await second.completion;
});

test("stopping a watch sends ctrl+c to its pane and settles as killed", async () => {
	const fake = createFakeCli();
	const registry = herdrRegistry(fake);
	const { record, completion } = await registry.start({ kind: "watch", command: "bun dev", cwd });
	registry.stop(record.id);
	const finished = await completion;
	assert.equal(finished.status, "killed");
	const keys = fake.execCalls.find((args) => args[0] === "pane" && args[1] === "send-keys");
	assert.deepEqual(keys?.slice(2), [record.paneId, "ctrl+c"]);
});

test("a watch falls back to the local backend when herdr refuses to split", async () => {
	const fake = createFakeCli();
	fake.respond("pane layout", () => failed("not_found"));
	fake.respond("pane split", () => failed("not_found", "pane not found"));
	const registry = herdrRegistry(fake);
	const { record, completion } = await registry.start({
		kind: "watch",
		command: "echo local-fallback",
		cwd,
	});
	assert.equal(record.backend, "local");
	assert.ok(record.fallbackReason);
	const finished = await completion;
	assert.equal(finished.exitCode, 0);
	assert.match(registry.tail(record.id, 5), /local-fallback/);
});

test("an agent run settles when its status wait fires", async () => {
	const fake = createFakeCli();
	fake.respond("agent start", () =>
		ok({ result: { agent: { pane_id: "w1:p7" }, type: "agent_started" } }),
	);
	fake.respond("pane read", () => ok(undefined, "I finished the review.\nAll good."));
	const registry = herdrRegistry(fake, {
		env: {
			CODEX_HOME: "/tmp/isolated-codex",
			PI_CODING_AGENT_DIR: "/tmp/isolated-pi",
			ADVISOR_STATE_DIR: "/tmp/isolated-advisor",
			PATH: "/tmp/isolated-pi/bin:/usr/bin",
			OPENAI_API_KEY: "must-not-enter-pane-args",
		},
	});
	const { record, completion } = await registry.start({
		kind: "agent",
		command: "codex",
		cwd,
		label: "reviewer",
		prompt: "Review the diff.",
		closeOnSettle: true,
	});
	assert.equal(record.paneId, "w1:p7");
	assert.match(record.agentName ?? "", /^reviewer-/);

	assert.ok(
		!fake.execCalls.some((args) => args[0] === "tab" && args[1] === "create"),
		"agent does not create another tab",
	);
	const started = fake.execCalls.find((args) => args[0] === "agent" && args[1] === "start");
	assert.equal(started?.[started.indexOf("--kind") + 1], "codex", "kind derived from argv[0]");
	assert.ok(started?.includes("--pane"), "agent starts in a pre-split pane");
	const callerSplit = fake.execCalls.find(
		(args) => args[0] === "pane" && args[1] === "split" && args[2] === "w1:p1",
	);
	assert.equal(
		callerSplit?.[callerSplit.indexOf("--direction") + 1],
		"right",
		"first caller split is always right",
	);
	assert.ok(callerSplit?.includes("--no-focus"), "caller retains focus");
	const inheritedEnv = callerSplit
		?.flatMap((value, index, args) => (value === "--env" ? [args[index + 1]] : []))
		.filter((value): value is string => Boolean(value));
	assert.deepEqual(inheritedEnv, [
		"ADVISOR_STATE_DIR=/tmp/isolated-advisor",
		"CODEX_HOME=/tmp/isolated-codex",
		"PATH=/tmp/isolated-pi/bin:/usr/bin",
		"PI_CODING_AGENT_DIR=/tmp/isolated-pi",
	]);
	assert.ok(!callerSplit?.some((value) => value.includes("must-not-enter-pane-args")), "secrets are not inherited");

	const prompted = fake.execCalls.find((args) => args[0] === "agent" && args[1] === "prompt");
	assert.equal(prompted?.[3], "Review the diff.");

	const renamed = fake.execCalls.find(
		(args) => args[0] === "pane" && args[1] === "rename" && args[2] === "w1:p7",
	);
	assert.equal(renamed?.[3], "reviewer", "agent pane is labeled with the run label");

	const working = fake.waiters.find((w) => w.args.includes("working"));
	assert.ok(working, "waits for the agent to start working");
	working?.resolveWith(ok({ event: "pane.agent_status_changed" }));
	// The done/idle/blocked race is spawned after `working` resolves.
	await new Promise((r) => setTimeout(r, 20));
	fake.respond("agent get", () => agentGet("w1:p7", record.agentName ?? "", "done"));
	const done = fake.waiters.find((w) => w.args.includes("done"));
	assert.ok(done, "races a wait on done");
	done?.resolveWith(ok({ event: "pane.agent_status_changed" }));

	const finished = await completion;
	assert.equal(finished.agentState, "done");
	assert.equal(finished.status, "exited");
	assert.match(registry.tail(record.id, 10), /I finished the review/);
	await flushAsync();
	assert.ok(
		fake.execCalls.some((args) => args[0] === "pane" && args[1] === "close" && args[2] === "w1:p7"),
		"successful agent pane closes after its transcript is captured",
	);
	const blocked = fake.waiters.find((w) => w.args.includes("blocked"));
	assert.equal(blocked?.killedByDriver, true, "loser waits are cancelled");
});

test("agent settlement reconciles live state after every status waiter fails", async () => {
	const fake = createFakeCli();
	fake.respond("agent start", () =>
		ok({ result: { agent: { pane_id: "w1:p7" }, type: "agent_started" } }),
	);
	const registry = herdrRegistry(fake);
	const { record, completion } = await registry.start({
		kind: "agent",
		command: "codex",
		cwd,
		label: "reconciled",
		prompt: "Finish despite a Herdr waiter restart.",
	});
	fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(ok({}));
	await waitUntil(() => fake.waiters.filter((waiter) => ["done", "idle", "blocked"].some((state) => waiter.args.includes(state))).length === 3);
	fake.respond("agent get", () => agentGet("w1:p7", record.agentName ?? "", "done"));
	for (const waiter of fake.waiters.filter((value) => ["done", "idle", "blocked"].some((state) => value.args.includes(state)))) {
		waiter.resolveWith(failed("server_unavailable", "herdr restarted"));
	}

	const finished = await completion;
	assert.equal(finished.agentState, "done");
	assert.equal(finished.status, "exited");
	assert.doesNotMatch(registry.tail(record.id, 10), /unknown|status waits failed/);
});

test("agent settlement re-arms waits when reconciliation still finds working", async () => {
	const fake = createFakeCli();
	fake.respond("agent start", () =>
		ok({ result: { agent: { pane_id: "w1:p7" }, type: "agent_started" } }),
	);
	let liveState = "working";
	const registry = herdrRegistry(fake);
	const { record, completion } = await registry.start({
		kind: "agent",
		command: "codex",
		cwd,
		label: "rearmed",
		prompt: "Keep working through waiter transport failure.",
	});
	fake.respond("agent get", () => agentGet("w1:p7", record.agentName ?? "", liveState));
	fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(ok({}));
	await waitUntil(() => fake.waiters.filter((waiter) => ["done", "idle", "blocked"].some((state) => waiter.args.includes(state))).length === 3);
	for (const waiter of fake.waiters.filter((value) => ["done", "idle", "blocked"].some((state) => value.args.includes(state)))) {
		waiter.resolveWith(failed("server_unavailable", "herdr restarted"));
	}
	await waitUntil(() => fake.waiters.filter((waiter) => waiter.args.includes("done")).length === 2);
	liveState = "done";
	fake.waiters.filter((waiter) => waiter.args.includes("done")).at(-1)?.resolveWith(ok({}));

	const finished = await completion;
	assert.equal(finished.agentState, "done");
	assert.equal(fake.waiters.filter((waiter) => waiter.args.includes("done")).length, 2);
});

test("a vanished agent with a valid required artifact settles successfully", async () => {
	const artifactDir = mkdtempSync(join(tmpdir(), "pi-detach-artifact-reconcile-"));
	const artifactPath = join(artifactDir, "result.md");
	await writeFile(
		artifactPath,
		"# Status\nDone\n# Claims\nBuilt\n# Evidence\nTests pass\n# Files\n- src/x.ts\n# Decisions\nNone\n# Remaining Risk\nNone\n",
	);
	try {
		const fake = createFakeCli();
		fake.respond("agent start", () =>
			ok({ result: { agent: { pane_id: "w1:p7" }, type: "agent_started" } }),
		);
		const registry = herdrRegistry(fake);
		const { record, completion } = await registry.start({
			kind: "agent",
			command: "codex",
			cwd,
			label: "artifact-reconciled",
			prompt: "Write the required final result.",
			requiredArtifactPath: artifactPath,
		});
		fake.respond("agent get", () => failed("not_found", "agent vanished after completion"));
		fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(ok({}));
		await waitUntil(() => fake.waiters.filter((waiter) => ["done", "idle", "blocked"].some((state) => waiter.args.includes(state))).length === 3);
		for (const waiter of fake.waiters.filter((value) => ["done", "idle", "blocked"].some((state) => value.args.includes(state)))) {
			waiter.resolveWith(failed("server_unavailable", "herdr restarted"));
		}

		const finished = await completion;
		assert.equal(finished.agentState, "done");
		assert.match(registry.tail(record.id, 10), /valid required result artifact/);
	} finally {
		await rm(artifactDir, { force: true, recursive: true });
	}
});

test("an unclassifiable agent with a valid required artifact settles successfully", async () => {
	const artifactDir = mkdtempSync(join(tmpdir(), "pi-detach-artifact-unclassifiable-"));
	const artifactPath = join(artifactDir, "result.md");
	await writeFile(
		artifactPath,
		"# Status\nDone\n# Claims\nBuilt\n# Evidence\nTests pass\n# Files\n- src/x.ts\n# Decisions\nNone\n# Remaining Risk\nNone\n",
	);
	try {
		const fake = createFakeCli();
		fake.respond("agent start", () =>
			ok({ result: { agent: { pane_id: "w1:p7" }, type: "agent_started" } }),
		);
		fake.respond("agent get", () => ok({ result: { type: "agent_info" } }));
		const registry = herdrRegistry(fake);
		const { record, completion } = await registry.start({
			kind: "agent",
			command: "codex",
			cwd,
			label: "artifact-unclassifiable",
			prompt: "Write the required final result.",
			requiredArtifactPath: artifactPath,
		});
		fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(ok({}));
		await waitUntil(() => fake.waiters.filter((waiter) => ["done", "idle", "blocked"].some((state) => waiter.args.includes(state))).length === 3);
		for (const waiter of fake.waiters.filter((value) => ["done", "idle", "blocked"].some((state) => value.args.includes(state)))) {
			waiter.resolveWith(failed("server_unavailable", "herdr restarted"));
		}

		const finished = await completion;
		assert.equal(finished.agentState, "done");
		assert.match(registry.tail(record.id, 10), /valid required result artifact/);
	} finally {
		await rm(artifactDir, { force: true, recursive: true });
	}
});

test("result artifact validation rejects empty files and missing headings", async () => {
	const artifactDir = mkdtempSync(join(tmpdir(), "pi-detach-artifact-validation-"));
	const artifactPath = join(artifactDir, "result.md");
	try {
		await writeFile(artifactPath, "");
		assert.match(await settlementArtifactIssue(artifactPath) ?? "", /empty .*result\.md/);
		await writeFile(artifactPath, "# Status\nDone\n");
		assert.match(
			await settlementArtifactIssue(artifactPath) ?? "",
			/missing headings: Claims, Evidence, Files, Decisions, Remaining Risk/,
		);
	} finally {
		await rm(artifactDir, { force: true, recursive: true });
	}
});

test("a missing required result artifact stalls settlement and keeps the pane", async () => {
	const artifactDir = mkdtempSync(join(tmpdir(), "pi-detach-artifact-missing-"));
	const artifactPath = join(artifactDir, "result.md");
	try {
		const fake = createFakeCli();
		fake.respond("agent start", () =>
			ok({ result: { agent: { pane_id: "w1:p7" }, type: "agent_started" } }),
		);
		fake.respond("pane read", () => ok(undefined, "Agent claimed success without writing the result."));
		const ledger = createSessionLedger({
			ledgerDir: artifactDir,
			sessionId: "artifact-session",
			ownerPid: 4242,
		});
		const registry = herdrRegistry(fake, { ledger });
		const { completion } = await registry.start({
			kind: "agent",
			command: "codex",
			cwd,
			label: "builder",
			prompt: "Build.",
			closeOnSettle: true,
			requiredArtifactPath: artifactPath,
		});
		fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(ok({}));
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
		fake.waiters.find((waiter) => waiter.args.includes("done"))?.resolveWith(ok({}));

		const finished = await completion;
		assert.equal(finished.agentState, "stalled");
		assert.match(registry.tail(finished.id, 20), /required result artifact is invalid: missing/);
		await flushAsync();
		assert.deepEqual(closedPanes(fake.execCalls), [], "invalid-artifact pane remains visible");
		assert.equal(ledger.read().records[0]?.closeOnSettle, false, "reload reaper cannot bypass artifact validation");
	} finally {
		await rm(artifactDir, { force: true, recursive: true });
	}
});

test("heading-only result artifacts stall settlement and keep the pane", async () => {
	const artifactDir = mkdtempSync(join(tmpdir(), "pi-detach-artifact-empty-sections-"));
	const artifactPath = join(artifactDir, "result.md");
	await writeFile(
		artifactPath,
		"# Status\n# Claims\n# Evidence\n# Files\n# Decisions\n# Remaining Risk\n",
	);
	try {
		const fake = createFakeCli();
		fake.respond("agent start", () =>
			ok({ result: { agent: { pane_id: "w1:p7" }, type: "agent_started" } }),
		);
		fake.respond("pane read", () => ok(undefined, "Agent wrote headings without evidence."));
		const registry = herdrRegistry(fake);
		const { completion } = await registry.start({
			kind: "agent",
			command: "codex",
			cwd,
			label: "checker",
			prompt: "Check.",
			closeOnSettle: true,
			requiredArtifactPath: artifactPath,
		});
		fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(ok({}));
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
		fake.waiters.find((waiter) => waiter.args.includes("done"))?.resolveWith(ok({}));

		const finished = await completion;
		assert.equal(finished.agentState, "stalled");
		assert.match(registry.tail(finished.id, 20), /has empty sections: Status, Claims, Evidence, Files, Decisions, Remaining Risk/);
		await flushAsync();
		assert.deepEqual(closedPanes(fake.execCalls), [], "heading-only artifact pane remains visible");
	} finally {
		await rm(artifactDir, { force: true, recursive: true });
	}
});

test("a valid required result artifact preserves successful close-on-settle", async () => {
	const artifactDir = mkdtempSync(join(tmpdir(), "pi-detach-artifact-valid-"));
	const artifactPath = join(artifactDir, "result.md");
	await writeFile(
		artifactPath,
		"# Status\nDone\n# Claims\nBuilt\n# Evidence\nTests pass\n# Files\n- src/x.ts\n# Decisions\nNone\n# Remaining Risk\nNone\n",
	);
	try {
		const fake = createFakeCli();
		fake.respond("agent start", () =>
			ok({ result: { agent: { pane_id: "w1:p7" }, type: "agent_started" } }),
		);
		fake.respond("pane read", () => ok(undefined, "Agent wrote the bounded result."));
		const registry = herdrRegistry(fake);
		const { record, completion } = await registry.start({
			kind: "agent",
			command: "codex",
			cwd,
			label: "builder",
			prompt: "Build.",
			closeOnSettle: true,
			requiredArtifactPath: artifactPath,
		});
		fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(ok({}));
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
		fake.respond("agent get", () => agentGet("w1:p7", record.agentName ?? "", "done"));
		fake.waiters.find((waiter) => waiter.args.includes("done"))?.resolveWith(ok({}));

		const finished = await completion;
		assert.equal(finished.agentState, "done");
		await flushAsync();
		assert.deepEqual(closedPanes(fake.execCalls), ["w1:p7"]);
	} finally {
		await rm(artifactDir, { force: true, recursive: true });
	}
});

test("a working-wait timeout stays supervised while compaction is running", async () => {
	const fake = createFakeCli();
	fake.respond("agent get", () =>
		ok({ result: { agent: { pane_id: "w1:p7", name: "reviewer-abc" }, type: "agent_info" } }),
	);
	let reads = 0;
	fake.respond("pane read", () => {
		reads += 1;
		return ok(
			undefined,
			reads === 1
				? "prior output\n◐ OpenAI compaction running…\nCompacting context..."
				: "✓ OpenAI compaction complete\ncontinued task\nfinal answer",
		);
	});
	const registry = herdrRegistry(fake);
	const { completion } = await registry.start({
		kind: "agent",
		command: "pi",
		cwd,
		prompt: "Continue after compaction.",
		reuseName: "reviewer-abc",
	});

	fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(failed("timeout"));
	await flushAsync();

	let completed = false;
	void completion.then(() => {
		completed = true;
	});
	await flushAsync();
	assert.equal(completed, false, "compaction does not settle the run as stalled");
	const workingWaiters = fake.waiters.filter((waiter) => waiter.args.includes("working"));
	assert.equal(workingWaiters.length, 2, "driver rearms the working wait through compaction");
	workingWaiters.at(-1)?.resolveWith(ok({}));
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	fake.waiters.find((waiter) => waiter.args.includes("done"))?.resolveWith(ok({}));

	const finished = await completion;
	assert.equal(finished.agentState, "done");
});

test("a non-compacting working-wait timeout settles stalled with the existing note", async () => {
	const fake = createFakeCli();
	fake.respond("agent start", () =>
		ok({ result: { agent: { pane_id: "w1:p7" }, type: "agent_started" } }),
	);
	fake.respond("pane read", () => ok(undefined, "agent remained idle"));
	const registry = herdrRegistry(fake);
	const { completion } = await registry.start({
		kind: "agent",
		command: "pi",
		cwd,
		prompt: "Start work.",
	});

	fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(failed("timeout"));
	const finished = await completion;
	assert.equal(finished.agentState, "stalled");
	assert.match(
		registry.tail(finished.id, 10),
		/the prompt did not visibly start a turn within 20s — check the pane/,
	);
});

test("an agent run stays supervised through transient compaction", async () => {
	const fake = createFakeCli();
	fake.respond("agent start", () =>
		ok({ result: { agent: { pane_id: "w1:p7" }, type: "agent_started" } }),
	);
	let reads = 0;
	fake.respond("pane read", () => {
		reads += 1;
		return ok(
			undefined,
			reads === 1
				? "Error: This operation was aborted\n◐ OpenAI compaction running…\nCompacting context..."
				: "◐ OpenAI compaction running…\n✓ OpenAI compaction complete\ncontinued task\nfinal answer",
		);
	});
	const registry = herdrRegistry(fake);
	const { record, completion } = await registry.start({
		kind: "agent",
		command: "pi",
		cwd,
		label: "compacting-worker",
		prompt: "Keep working after compaction.",
		closeOnSettle: true,
	});

	fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(ok({}));
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	fake.waiters.find((waiter) => waiter.args.includes("done"))?.resolveWith(ok({}));
	await flushAsync();

	let completed = false;
	void completion.then(() => {
		completed = true;
	});
	await flushAsync();
	assert.equal(completed, false, "transient done does not settle the detached run");
	assert.equal(closedPanes(fake.execCalls).length, 0, "pane remains alive while compaction runs");

	const workingWaiters = fake.waiters.filter((waiter) => waiter.args.includes("working"));
	assert.equal(workingWaiters.length, 2, "driver waits for the post-compaction continuation");
	workingWaiters.at(-1)?.resolveWith(ok({}));
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	const doneWaiters = fake.waiters.filter((waiter) => waiter.args.includes("done"));
	assert.equal(doneWaiters.length, 2, "driver rearms settlement after continuation starts");
	fake.respond("agent get", () => agentGet("w1:p7", record.agentName ?? "", "done"));
	doneWaiters.at(-1)?.resolveWith(ok({}));

	const finished = await completion;
	assert.equal(finished.agentState, "done");
	assert.match(registry.tail(record.id, 10), /final answer/);
	await flushAsync();
	assert.deepEqual(closedPanes(fake.execCalls), ["w1:p7"]);
});

test("agent start retries Herdr's transient busy code and legacy prose", async () => {
	const fake = createFakeCli();
	let starts = 0;
	fake.respond("agent start", () => {
		starts += 1;
		if (starts === 1) return failed("agent_pane_busy", "pane still initializing");
		if (starts === 2) {
			return failed("invalid_state", "agent target pane w1:p2 is not an available shell");
		}
		return ok({ result: { agent: { pane_id: "w1:p2" }, type: "agent_started" } });
	});
	const registry = herdrRegistry(fake);
	const { record, completion } = await registry.start({
		kind: "agent",
		command: "pi",
		cwd,
		prompt: "Verify retry behavior.",
	});
	assert.equal(starts, 3, "the same pre-split pane is retried until Herdr accepts it");
	assert.equal(record.paneId, "w1:p2");
	assert.equal(
		fake.execCalls.filter((args) => args[0] === "pane" && args[1] === "split").length,
		1,
		"retry does not create replacement panes",
	);
	assert.ok(
		!fake.execCalls.some((args) => args[0] === "pane" && args[1] === "close"),
		"a transient refusal does not discard the pane",
	);
	fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(ok({}));
	await new Promise((complete) => setTimeout(complete, 20));
	fake.waiters.find((waiter) => waiter.args.includes("idle"))?.resolveWith(ok({}));
	const finished = await completion;
	assert.equal(finished.agentState, "idle");
});

test("agent start does not retry non-readiness failures", async () => {
	const fake = createFakeCli();
	let starts = 0;
	fake.respond("agent start", () => {
		starts += 1;
		return failed("invalid_argument", "unknown agent kind");
	});
	const registry = herdrRegistry(fake);
	await assert.rejects(
		registry.start({ kind: "agent", command: "pi", cwd, prompt: "Do not launch." }),
		/unknown agent kind/,
	);
	assert.equal(starts, 1);
	const closes = fake.execCalls.filter((args) => args[0] === "pane" && args[1] === "close");
	assert.equal(closes.length, 1, "a permanent failure closes its split pane exactly once");
	assert.equal(closes[0]?.[2], "w1:p2");
});

test("agent start times out and closes a pane that never reaches a shell prompt", async () => {
	const fake = createFakeCli();
	fake.respond("pane process-info", () =>
		ok({
			result: {
				process_info: {
					foreground_processes: [{ name: "zsh" }, { name: "shell-init" }],
				},
			},
		}),
	);
	const originalSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((
		handler: (...args: any[]) => void,
		_delay?: number,
		...args: any[]
	) => originalSetTimeout(handler, 0, ...args)) as typeof globalThis.setTimeout;
	try {
		const registry = herdrRegistry(fake);
		await assert.rejects(
			registry.start({ kind: "agent", command: "pi", cwd, prompt: "Never starts." }),
			/shell readiness timed out/,
		);
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}
	const starts = fake.execCalls.filter((args) => args[0] === "agent" && args[1] === "start");
	assert.equal(starts.length, 0, "agent start is not attempted while the shell gate stays busy");
	const readinessChecks = fake.execCalls.filter(
		(args) => args[0] === "pane" && args[1] === "process-info",
	);
	assert.equal(readinessChecks.length, 120, "timeout uses the full bounded readiness loop");
	const closes = fake.execCalls.filter((args) => args[0] === "pane" && args[1] === "close");
	assert.equal(closes.length, 1, "timeout closes the split pane exactly once");
	assert.equal(closes[0]?.[2], "w1:p2");
});

test("a multiline Pi prompt is submitted atomically via agent prompt", async () => {
	const fake = createFakeCli();
	fake.respond("agent start", () =>
		ok({ result: { agent: { pane_id: "w1:p7" }, type: "agent_started" } }),
	);
	fake.respond("pane read", () => ok(undefined, "role task finished"));
	const registry = herdrRegistry(fake);
	const prompt = "/skill:role-scout ROLE: scout\n\nTASK: inspect";
	const { record, completion } = await registry.start({
		kind: "agent",
		command: "pi --model gpt-5.6-sol",
		cwd,
		prompt,
	});
	const prompted = fake.execCalls.find((args) => args[0] === "agent" && args[1] === "prompt");
	assert.equal(prompted?.[2], record.agentName, "prompt targets the agent by name");
	assert.equal(prompted?.[3], prompt, "full multiline prompt in one atomic submit");
	assert.deepEqual(
		prompted?.slice(4),
		[
			"--wait",
			"--until",
			"working",
			"--until",
			"done",
			"--until",
			"idle",
			"--until",
			"blocked",
			"--timeout",
			"20000",
		],
		"submission waits for every meaningful post-prompt lifecycle state",
	);
	const promptCallIndex = fake.execCalls.indexOf(prompted ?? []);
	assert.equal(fake.execTimeouts[promptCallIndex], 25_000, "process timeout exceeds Herdr's wait budget");
	assert.ok(
		!fake.execCalls.some((args) => args[0] === "pane" && args[1] === "send-keys"),
		"no Enter retry is needed",
	);
	fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(ok({}));
	await new Promise((complete) => setTimeout(complete, 20));
	fake.waiters.find((waiter) => waiter.args.includes("idle"))?.resolveWith(ok({}));
	const finished = await completion;
	assert.equal(finished.agentState, "idle");
});

test("prompt wait accepts an immediate terminal state without a working waiter", async () => {
	const fake = createFakeCli();
	fake.respond("agent start", () =>
		ok({ result: { agent: { pane_id: "w1:p7" }, type: "agent_started" } }),
	);
	fake.respond("agent prompt", () => ok({ result: { agent: { agent_status: "done" } } }));
	fake.respond("pane read", () => ok(undefined, "fast task finished"));
	const registry = herdrRegistry(fake);
	const { completion } = await registry.start({
		kind: "agent",
		command: "codex",
		cwd,
		prompt: "Finish quickly.",
	});

	const finished = await completion;
	assert.equal(finished.agentState, "done");
	assert.equal(fake.waiters.length, 0, "a lifecycle-bound prompt cannot miss fast settlement");
});

test("a stalled prompt gets one guarded Enter and recognizes a fast terminal turn", async () => {
	const fake = createFakeCli();
	let expectedName = "";
	fake.respond("agent start", (args) => {
		expectedName = args[2] ?? "";
		return ok({ result: { agent: { pane_id: "w1:p7" }, type: "agent_started" } });
	});
	let gets = 0;
	fake.respond("agent get", () => {
		gets += 1;
		return agentGet("w1:p7", expectedName, gets < 3 ? "idle" : "done", gets < 3 ? 7 : 8);
	});
	fake.respond("agent prompt", () => failed("agent_prompt_stalled", "no state change"));
	fake.respond("pane read", () => ok(undefined, "recovered task finished"));
	const registry = herdrRegistry(fake);
	const { record, completion } = await registry.start({
		kind: "agent",
		command: "codex",
		cwd,
		label: "checker",
		prompt: "Check the result.",
	});
	assert.equal(record.agentName, expectedName);
	const enters = fake.execCalls.filter(
		(args) => args[0] === "pane" && args[1] === "send-keys" && args[3] === "enter",
	);
	assert.equal(enters.length, 1, "recovery presses Enter exactly once");
	fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(failed("timeout"));

	const finished = await completion;
	assert.equal(finished.agentState, "done", "generation change recovers a missed working state");
});

test("a stalled prompt never presses Enter for a different occupant", async () => {
	const fake = createFakeCli();
	fake.respond("agent start", () =>
		ok({ result: { agent: { pane_id: "w1:p7" }, type: "agent_started" } }),
	);
	fake.respond("agent get", () => agentGet("w1:p7", "replacement", "idle", 9));
	fake.respond("agent prompt", () => failed("agent_prompt_stalled", "no state change"));
	fake.respond("pane read", () => ok(undefined, "replacement occupant"));
	const registry = herdrRegistry(fake);
	const { completion } = await registry.start({
		kind: "agent",
		command: "codex",
		cwd,
		prompt: "Do not send this twice.",
	});

	const finished = await completion;
	assert.equal(finished.agentState, "stalled");
	assert.match(registry.tail(finished.id, 10), /without a safe same-agent recovery/);
	assert.ok(
		!fake.execCalls.some((args) => args[0] === "pane" && args[1] === "send-keys"),
		"mismatched occupant receives no input",
	);
});

test("a blocked agent is reported as blocked", async () => {
	const fake = createFakeCli();
	fake.respond("agent start", () =>
		ok({ result: { agent: { pane_id: "w1:p7" }, type: "agent_started" } }),
	);
	fake.respond("pane read", () => ok(undefined, "May I run `rm -rf dist`? [y/n]"));
	const registry = herdrRegistry(fake);
	const { record, completion } = await registry.start({
		kind: "agent",
		command: "codex",
		cwd,
		prompt: "Clean the build.",
		closeOnSettle: true,
	});
	fake.waiters.find((w) => w.args.includes("working"))?.resolveWith(ok({}));
	await new Promise((r) => setTimeout(r, 20));
	fake.waiters.find((w) => w.args.includes("blocked"))?.resolveWith(ok({}));
	const finished = await completion;
	assert.equal(finished.agentState, "blocked");
	assert.match(registry.tail(record.id, 5), /rm -rf dist/);
	assert.ok(
		!fake.execCalls.some((args) => args[0] === "pane" && args[1] === "close" && args[2] === "w1:p7"),
		"blocked agent pane stays visible for input",
	);
});

test("bg_agent without herdr fails loudly instead of falling back", async () => {
	const registry = createRegistry();
	await assert.rejects(
		registry.start({ kind: "agent", command: "codex", cwd, prompt: "hi" }),
		/inside a herdr pane/,
	);
});

test("reusing a live agent by name skips agent start", async () => {
	const fake = createFakeCli();
	fake.respond("agent get", () =>
		ok({ result: { agent: { pane_id: "w1:p7", name: "reviewer-abc" }, type: "agent_info" } }),
	);
	fake.respond("pane read", () => ok(undefined, "follow-up answered"));
	const registry = herdrRegistry(fake);
	const { record, completion } = await registry.start({
		kind: "agent",
		command: "codex",
		cwd,
		prompt: "And the tests?",
		reuseName: "reviewer-abc",
	});
	assert.equal(record.agentName, "reviewer-abc");
	assert.ok(!fake.execCalls.some((args) => args[0] === "agent" && args[1] === "start"));
	assert.ok(!fake.execCalls.some((args) => args[0] === "tab" && args[1] === "create"));
	fake.waiters.find((w) => w.args.includes("working"))?.resolveWith(ok({}));
	await new Promise((r) => setTimeout(r, 20));
	fake.waiters.find((w) => w.args.includes("idle"))?.resolveWith(ok({}));
	const finished = await completion;
	assert.equal(finished.agentState, "idle");
});

test("the first helper splits the caller; further agents stack off run panes", async () => {
	const fake = createFakeCli();
	let agentPane = 20;
	fake.respond("agent start", (args) => {
		const paneFlag = args.indexOf("--pane");
		const paneId = paneFlag >= 0 ? args[paneFlag + 1] : `w1:p${++agentPane}`;
		return ok({ result: { agent: { pane_id: paneId }, type: "agent_started" } });
	});
	const registry = herdrRegistry(fake);
	const records: { paneId?: string | undefined }[] = [];
	const completions: Promise<unknown>[] = [];
	for (const label of ["builder", "checker", "verifier"]) {
		const { record, completion } = await registry.start({
			kind: "agent",
			command: "codex",
			cwd,
			label,
			prompt: "Work.",
			closeOnSettle: false,
		});
		records.push(record);
		completions.push(completion);
		fake.waiters
			.filter((w) => w.args.includes("working"))
			.at(-1)
			?.resolveWith(ok({ event: "pane.agent_status_changed" }));
		await new Promise((r) => setTimeout(r, 20));
	}
	const starts = fake.execCalls.filter((args) => args[0] === "agent" && args[1] === "start");
	assert.equal(starts.length, 3);
	assert.ok(starts.every((args) => args.includes("--kind") && args.includes("--pane")));
	const callerSplits = fake.execCalls.filter(
		(args) => args[0] === "pane" && args[1] === "split" && args[2] === "w1:p1",
	);
	assert.equal(callerSplits.length, 1, "caller is not split again while a run pane exists");
	assert.equal(splitDirection(callerSplits[0]), "right");
	const workerSplit = fake.execCalls.find(
		(args) => args[0] === "pane" && args[1] === "split" && args[2] === records[0]?.paneId,
	);
	assert.ok(workerSplit, "second agent stacks off the first run pane");
	for (const waiter of fake.waiters.filter((w) => w.args.includes("done"))) {
		waiter.resolveWith(ok({ event: "pane.agent_status_changed" }));
	}
	await Promise.all(completions);
});

test("parallel agent starts coordinate caller splits", async () => {
	const fake = createFakeCli();
	let agentPane = 20;
	fake.respond("agent start", (args) => {
		const paneFlag = args.indexOf("--pane");
		const paneId = paneFlag >= 0 ? args[paneFlag + 1] : `w1:p${++agentPane}`;
		return ok({ result: { agent: { pane_id: paneId }, type: "agent_started" } });
	});
	const registry = herdrRegistry(fake);
	const launches = await Promise.all(
		["builder", "checker", "verifier"].map((label) =>
			registry.start({
				kind: "agent",
				command: "codex",
				cwd,
				label,
				prompt: "Work.",
				closeOnSettle: false,
			}),
		),
	);
	const records = launches.map(({ record }) => record);
	const callerSplits = fake.execCalls.filter(
		(args) => args[0] === "pane" && args[1] === "split" && args[2] === "w1:p1",
	);
	assert.equal(callerSplits.length, 1, "parallel launches still only split the caller once while run panes live");
	const workerSplit = fake.execCalls.find(
		(args) => args[0] === "pane" && args[1] === "split" && args[2] === records[0]?.paneId,
	);
	assert.ok(workerSplit, "the second parallel agent splits off a worker pane");
	fake.waiters
		.filter((waiter) => waiter.args.includes("working"))
		.forEach((waiter) => waiter.resolveWith(ok({ event: "pane.agent_status_changed" })));
	await new Promise((complete) => setTimeout(complete, 20));
	fake.waiters
		.filter((waiter) => waiter.args.includes("done"))
		.forEach((waiter) => waiter.resolveWith(ok({ event: "pane.agent_status_changed" })));
	await Promise.all(launches.map(({ completion }) => completion));
});

test("an agent launch writes a ledger record and drops it when the driver closes the pane", async () => {
	const fake = createFakeCli();
	fake.respond("agent start", () =>
		ok({ result: { agent: { pane_id: "w1:p7" }, type: "agent_started" } }),
	);
	fake.respond("pane read", () => ok(undefined, "review done"));
	const ledger = createSessionLedger({
		ledgerDir: mkdtempSync(join(tmpdir(), "pi-detach-ledger-")),
		sessionId: "sess-live",
		ownerPid: 4242,
	});
	const registry = herdrRegistry(fake, { ledger });
	const { record, completion } = await registry.start({
		kind: "agent",
		command: "codex",
		cwd,
		label: "reviewer",
		prompt: "Review.",
		closeOnSettle: true,
	});
	const tracked = ledger.read().records;
	assert.equal(tracked.length, 1);
	assert.equal(tracked[0]?.paneId, "w1:p7");
	assert.equal(tracked[0]?.agentName, record.agentName);
	assert.equal(tracked[0]?.runId, record.id);
	assert.equal(tracked[0]?.closeOnSettle, true);
	assert.equal(tracked[0]?.ownerPid, 4242);

	fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(ok({}));
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	fake.respond("agent get", () => agentGet("w1:p7", record.agentName ?? "", "done"));
	fake.waiters.find((waiter) => waiter.args.includes("done"))?.resolveWith(ok({}));
	await completion;
	await flushAsync();
	assert.equal(ledger.read().records.length, 0, "driver forgets the record when it closes the pane");
});

test("a failed pane close retains the ledger record", async () => {
	const fake = createFakeCli();
	fake.respond("agent start", () =>
		ok({ result: { agent: { pane_id: "w1:p7" }, type: "agent_started" } }),
	);
	fake.respond("pane read", () => ok(undefined, "review done"));
	fake.respond("pane close", () => failed("unavailable", "herdr restart"));
	const ledger = createSessionLedger({
		ledgerDir: mkdtempSync(join(tmpdir(), "pi-detach-ledger-")),
		sessionId: "sess-live",
		ownerPid: 4242,
	});
	const registry = herdrRegistry(fake, { ledger });
	const { record, completion } = await registry.start({
		kind: "agent",
		command: "codex",
		cwd,
		label: "reviewer",
		prompt: "Review.",
		closeOnSettle: true,
	});
	fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(ok({}));
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	fake.respond("agent get", () => agentGet("w1:p7", record.agentName ?? "", "done"));
	fake.waiters.find((waiter) => waiter.args.includes("done"))?.resolveWith(ok({}));
	await completion;
	await flushAsync();
	assert.equal(ledger.read().records.length, 1, "forget waits for a successful close");
});

test("pre-launch orphan sweep does not delay agent start", async () => {
	const fake = createFakeCli();
	fake.respond("agent start", () =>
		ok({ result: { agent: { pane_id: "w1:p7" }, type: "agent_started" } }),
	);
	fake.respond("pane read", () => ok(undefined, "ok"));
	let sweepStarted = false;
	const reapOrphans = (): Promise<void> => {
		sweepStarted = true;
		return new Promise(() => {
			// Never resolves — an unavailable server must not stall the launch.
		});
	};
	const registry = herdrRegistry(fake, { reapOrphans });
	const { completion } = await registry.start({
		kind: "agent",
		command: "codex",
		cwd,
		prompt: "Go.",
		closeOnSettle: false,
	});
	assert.equal(sweepStarted, true);
	fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(ok({}));
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	fake.waiters.find((waiter) => waiter.args.includes("idle"))?.resolveWith(ok({}));
	await completion;
});

test("close-on-settle skips pane close when the occupant was replaced", async () => {
	const fake = createFakeCli();
	fake.respond("agent start", () =>
		ok({ result: { agent: { pane_id: "w1:p7" }, type: "agent_started" } }),
	);
	fake.respond("pane read", () => ok(undefined, "review done"));
	const ledger = createSessionLedger({
		ledgerDir: mkdtempSync(join(tmpdir(), "pi-detach-ledger-")),
		sessionId: "sess-live",
		ownerPid: 4242,
	});
	const registry = herdrRegistry(fake, { ledger });
	const { record, completion } = await registry.start({
		kind: "agent",
		command: "codex",
		cwd,
		label: "reviewer",
		prompt: "Review.",
		closeOnSettle: true,
	});
	fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(ok({}));
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	fake.respond("agent get", () => agentGet("w1:p7", "replacement-agent", "idle"));
	fake.waiters.find((waiter) => waiter.args.includes("done"))?.resolveWith(ok({}));
	const finished = await completion;
	await flushAsync();
	assert.equal(finished.agentState, "done");
	assert.equal(finished.status, "exited");
	assert.equal(closedPanes(fake.execCalls).length, 0, "replaced occupant is not closed");
	assert.equal(ledger.read().records.length, 1, "ledger stays so a later reap can decide");
	assert.notEqual(record.agentName, "replacement-agent");
});

test("close-on-settle still closes when the confirm get matches this occupant", async () => {
	const fake = createFakeCli();
	fake.respond("agent start", () =>
		ok({ result: { agent: { pane_id: "w1:p7" }, type: "agent_started" } }),
	);
	fake.respond("pane read", () => ok(undefined, "review done"));
	const ledger = createSessionLedger({
		ledgerDir: mkdtempSync(join(tmpdir(), "pi-detach-ledger-")),
		sessionId: "sess-live",
		ownerPid: 4242,
	});
	const registry = herdrRegistry(fake, { ledger });
	const { record, completion } = await registry.start({
		kind: "agent",
		command: "codex",
		cwd,
		label: "reviewer",
		prompt: "Review.",
		closeOnSettle: true,
	});
	fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(ok({}));
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	fake.respond("agent get", () => agentGet("w1:p7", record.agentName ?? "", "idle"));
	fake.waiters.find((waiter) => waiter.args.includes("idle"))?.resolveWith(ok({}));
	const finished = await completion;
	await flushAsync();
	assert.equal(finished.agentState, "idle");
	assert.deepEqual(closedPanes(fake.execCalls), ["w1:p7"]);
	assert.equal(ledger.read().records.length, 0);
});

test("pane manager: first caller split is right even when the caller is tall", async () => {
	const fake = createFakeCli();
	fake.respond("pane layout", () =>
		ok({
			result: {
				layout: {
					panes: [{ pane_id: "w1:p1", rect: { width: 40, height: 80 } }],
				},
			},
		}),
	);
	const { panes } = paneManagerOf(fake);
	await panes.acquire(cwd, "one");
	const first = splitCalls(fake.execCalls)[0];
	assert.equal(first?.[2], "w1:p1");
	assert.equal(splitDirection(first), "right");
});

test("pane manager: second helper stacks off the run pane", async () => {
	const fake = createFakeCli();
	const { panes } = paneManagerOf(fake);
	const first = await panes.acquire(cwd, "one");
	await panes.acquire(cwd, "two");
	const splits = splitCalls(fake.execCalls);
	assert.equal(splits.length, 2);
	assert.equal(splits[0]?.[2], "w1:p1");
	assert.equal(splits[1]?.[2], first.paneId, "second helper does not recarve the caller");
});

test("pane manager: pooled reuse does not consume the caller-split budget", async () => {
	const fake = createFakeCli();
	const { panes } = paneManagerOf(fake);
	const first = await panes.acquire(cwd, "one");
	panes.release(first.paneId);
	const second = await panes.acquire(cwd, "two");
	assert.equal(second.reused, true);
	assert.equal(second.paneId, first.paneId);
	assert.equal(splitCalls(fake.execCalls).length, 1);
});

test("pane manager: a closed caller child frees its slot — the resplit is right again", async () => {
	const fake = createFakeCli();
	const { panes } = paneManagerOf(fake);
	const first = await panes.acquire(cwd, "one");
	panes.discard(first.paneId);
	await panes.acquire(cwd, "two");
	const callerSplits = splitCalls(fake.execCalls).filter((args) => args[2] === "w1:p1");
	assert.equal(callerSplits.length, 2);
	assert.equal(splitDirection(callerSplits[0]), "right");
	assert.equal(splitDirection(callerSplits[1]), "right", "freed slot means the caller is whole again");
});

test("pane manager: a second concurrent caller split goes down", async () => {
	const fake = createFakeCli();
	const dead = new Set<string>();
	let nextPane = 100;
	fake.respond("pane split", (args) => {
		const target = args[2] ?? "";
		if (dead.has(target)) return failed("not_found", "pane not found");
		nextPane += 1;
		return ok({ result: { pane: { pane_id: `w1:p${nextPane}` }, type: "pane_info" } });
	});
	const { panes } = paneManagerOf(fake);
	const first = await panes.acquire(cwd, "one");
	dead.add(first.paneId);
	await panes.acquire(cwd, "two");
	const callerSplits = splitCalls(fake.execCalls).filter((args) => args[2] === "w1:p1");
	assert.equal(callerSplits.length, 2);
	assert.equal(splitDirection(callerSplits[0]), "right");
	assert.equal(splitDirection(callerSplits[1]), "down", "both children live: second slot splits down");
});

test("pane manager: two live caller children with no usable stack target still split the caller", async () => {
	const fake = createFakeCli();
	const dead = new Set<string>();
	let nextPane = 100;
	fake.respond("pane split", (args) => {
		const target = args[2] ?? "";
		if (dead.has(target)) return failed("not_found", "pane not found");
		nextPane += 1;
		return ok({ result: { pane: { pane_id: `w1:p${nextPane}` }, type: "pane_info" } });
	});
	const { panes } = paneManagerOf(fake);
	const first = await panes.acquire(cwd, "one");
	dead.add(first.paneId);
	const second = await panes.acquire(cwd, "two");
	dead.add(second.paneId);
	// Both caller children are live and neither accepts a split: the caller
	// remains the fallback so the launch still succeeds inside the tab.
	const third = await panes.acquire(cwd, "three");
	assert.equal(third.reused, false);
	const callerSplits = splitCalls(fake.execCalls).filter((args) => args[2] === "w1:p1");
	assert.equal(callerSplits.length, 3, "no cap: the caller hosts the third split");
	assert.equal(splitDirection(callerSplits[0]), "right");
	assert.equal(splitDirection(callerSplits[1]), "down");
	assert.equal(splitDirection(callerSplits[2]), "right", "third follows live wide geometry");
	assert.ok(
		!fake.execCalls.some((args) => args[0] === "tab" && args[1] === "create"),
		"no tab is ever created for pane allocation",
	);
	// The new caller child is a surviving target: the next helper stacks on it.
	const fourth = await panes.acquire(cwd, "four");
	assert.equal(fourth.reused, false);
	assert.equal(splitCalls(fake.execCalls).at(-1)?.[2], third.paneId);
});

test("pane manager: failed stack target prefers other created panes before the caller", async () => {
	const fake = createFakeCli();
	const dead = new Set<string>();
	let nextPane = 100;
	fake.respond("pane split", (args) => {
		const target = args[2] ?? "";
		if (dead.has(target)) return failed("not_found", "pane not found");
		nextPane += 1;
		return ok({ result: { pane: { pane_id: `w1:p${nextPane}` }, type: "pane_info" } });
	});
	const { panes } = paneManagerOf(fake);
	const first = await panes.acquire(cwd, "one");
	const second = await panes.acquire(cwd, "two");
	dead.add(second.paneId);
	const third = await panes.acquire(cwd, "three");
	assert.equal(third.reused, false);
	const splits = splitCalls(fake.execCalls);
	assert.equal(splits.filter((args) => args[2] === "w1:p1").length, 1);
	assert.ok(
		splits.some((args) => args[2] === first.paneId),
		"retry stacked off the surviving older run pane",
	);
	assert.equal(splits.at(-1)?.[2], first.paneId);
});

test("pane manager: failed stack-target retry off the caller takes a live slot; discards free it", async () => {
	const fake = createFakeCli();
	const dead = new Set<string>();
	let nextPane = 100;
	fake.respond("pane split", (args) => {
		const target = args[2] ?? "";
		if (dead.has(target)) return failed("not_found", "pane not found");
		nextPane += 1;
		return ok({ result: { pane: { pane_id: `w1:p${nextPane}` }, type: "pane_info" } });
	});
	const { panes } = paneManagerOf(fake);
	const first = await panes.acquire(cwd, "one");
	dead.add(first.paneId);
	const second = await panes.acquire(cwd, "two");
	const callerSplits = splitCalls(fake.execCalls).filter((args) => args[2] === "w1:p1");
	assert.equal(callerSplits.length, 2);
	assert.equal(splitDirection(callerSplits[0]), "right");
	assert.equal(splitDirection(callerSplits[1]), "down");
	dead.add(second.paneId);
	panes.discard(first.paneId);
	panes.discard(second.paneId);
	const third = await panes.acquire(cwd, "three");
	assert.equal(third.reused, false);
	const finalCallerSplits = splitCalls(fake.execCalls).filter((args) => args[2] === "w1:p1");
	assert.equal(finalCallerSplits.length, 3, "discarded children freed the caller slots");
	assert.equal(splitDirection(finalCallerSplits[2]), "right", "caller is whole again");
	assert.ok(
		!fake.execCalls.some((args) => args[0] === "tab" && args[1] === "create"),
		"no tab overflow needed once slots freed",
	);
});

test("when all agent run panes are gone the freed slot resplits the caller right", async () => {
	const fake = createFakeCli();
	const dead = new Set<string>();
	fake.respond("pane process-info", (args) => {
		const paneId = args[args.indexOf("--pane") + 1] ?? "";
		if (dead.has(paneId)) return failed("not_found");
		return idleShell();
	});
	fake.respond("agent start", (args) => {
		const paneFlag = args.indexOf("--pane");
		const paneId = paneFlag >= 0 ? args[paneFlag + 1] : "w1:p2";
		return ok({ result: { agent: { pane_id: paneId }, type: "agent_started" } });
	});
	const registry = herdrRegistry(fake);
	const first = await registry.start({
		kind: "agent",
		command: "codex",
		cwd,
		label: "builder",
		prompt: "Work.",
		closeOnSettle: false,
	});
	fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(ok({}));
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	if (first.record.paneId) dead.add(first.record.paneId);

	const second = await registry.start({
		kind: "agent",
		command: "codex",
		cwd,
		label: "checker",
		prompt: "Work.",
		closeOnSettle: false,
	});
	const callerSplits = splitCalls(fake.execCalls).filter((args) => args[2] === "w1:p1");
	assert.equal(callerSplits.length, 2);
	assert.equal(splitDirection(callerSplits[0]), "right");
	fake.waiters
		.filter((waiter) => waiter.args.includes("working"))
		.forEach((waiter) => waiter.resolveWith(ok({})));
	assert.equal(splitDirection(callerSplits[1]), "right", "pruned dead pane freed the caller slot");
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	fake.waiters
		.filter((waiter) => waiter.args.includes("done"))
		.forEach((waiter) => waiter.resolveWith(ok({})));
	await Promise.all([first.completion, second.completion]);
});

test("agent launches keep working as dead run panes free caller slots", async () => {
	const fake = createFakeCli();
	const dead = new Set<string>();
	fake.respond("pane process-info", (args) => {
		const paneId = args[args.indexOf("--pane") + 1] ?? "";
		if (dead.has(paneId)) return failed("not_found");
		return idleShell();
	});
	fake.respond("agent start", (args) => {
		const paneFlag = args.indexOf("--pane");
		const paneId = paneFlag >= 0 ? args[paneFlag + 1] : "w1:p2";
		return ok({ result: { agent: { pane_id: paneId }, type: "agent_started" } });
	});
	const registry = herdrRegistry(fake);
	const first = await registry.start({
		kind: "agent",
		command: "codex",
		cwd,
		label: "builder",
		prompt: "Work.",
		closeOnSettle: false,
	});
	fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(ok({}));
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	if (first.record.paneId) dead.add(first.record.paneId);

	const second = await registry.start({
		kind: "agent",
		command: "codex",
		cwd,
		label: "checker",
		prompt: "Work.",
		closeOnSettle: false,
	});
	fake.waiters
		.filter((waiter) => waiter.args.includes("working"))
		.at(-1)
		?.resolveWith(ok({}));
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	if (second.record.paneId) dead.add(second.record.paneId);

	const third = await registry.start({
		kind: "agent",
		command: "codex",
		cwd,
		label: "verifier",
		prompt: "Work.",
		closeOnSettle: false,
	});
	const callerSplits = splitCalls(fake.execCalls).filter((args) => args[2] === "w1:p1");
	assert.equal(callerSplits.length, 3, "each dead pane freed its caller slot");
	assert.ok(
		callerSplits.every((args) => splitDirection(args) === "right"),
		"every launch found the caller whole again",
	);
	assert.ok(
		!fake.execCalls.some((args) => args[0] === "tab" && args[1] === "create"),
		"no tab overflow needed when slots free up",
	);
	fake.waiters
		.filter((waiter) => waiter.args.includes("working"))
		.at(-1)
		?.resolveWith(ok({}));
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	fake.waiters
		.filter((waiter) => waiter.args.includes("done"))
		.forEach((waiter) => waiter.resolveWith(ok({})));
	await Promise.all([first.completion, second.completion, third.completion]);
});

test("mixed pane-manager and driver allocation share one caller-split budget", async () => {
	const startAgent = (fake: ReturnType<typeof createFakeCli>) => {
		fake.respond("agent start", (args) => {
			const paneFlag = args.indexOf("--pane");
			const paneId = paneFlag >= 0 ? args[paneFlag + 1] : "w1:p9";
			return ok({ result: { agent: { pane_id: paneId }, type: "agent_started" } });
		});
	};
	const wired = (fake: ReturnType<typeof createFakeCli>) => {
		const ctx = { paneId: "w1:p1", tabId: "w1:t7", workspaceId: "w1" };
		const panes = createPaneManager(fake.cli, ctx);
		const driver = createHerdrDriver({
			cli: fake.cli,
			ctx,
			panes,
			env: { PI_DETACH_HERDR_TOAST: "0" },
		});
		return { panes, registry: createRegistry({ herdrDriver: driver }) };
	};

	const sharing = createFakeCli();
	startAgent(sharing);
	const shared = wired(sharing);
	const watch = await shared.panes.acquire(cwd, "watch");
	const stackedAgent = await shared.registry.start({
		kind: "agent",
		command: "codex",
		cwd,
		label: "builder",
		prompt: "Work.",
		closeOnSettle: false,
	});
	const sharedCaller = splitCalls(sharing.execCalls).filter((args) => args[2] === "w1:p1");
	assert.equal(sharedCaller.length, 1, "agent stacks on the watch pane instead of recarving the caller");
	assert.equal(splitDirection(sharedCaller[0]), "right");
	assert.ok(
		splitCalls(sharing.execCalls).some((args) => args[2] === watch.paneId),
		"driver used the pane-manager's surviving target",
	);
	sharing.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(ok({}));
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	sharing.waiters.find((waiter) => waiter.args.includes("done"))?.resolveWith(ok({}));
	await stackedAgent.completion;

	const budget = createFakeCli();
	startAgent(budget);
	const spent = wired(budget);
	const first = await spent.panes.acquire(cwd, "watch");
	spent.panes.discard(first.paneId);
	const agent = await spent.registry.start({
		kind: "agent",
		command: "codex",
		cwd,
		label: "builder",
		prompt: "Work.",
		closeOnSettle: false,
	});
	const callerSplits = splitCalls(budget.execCalls).filter((args) => args[2] === "w1:p1");
	assert.equal(callerSplits.length, 2, "mixed allocators share one live-slot budget");
	assert.equal(splitDirection(callerSplits[0]), "right");
	assert.equal(splitDirection(callerSplits[1]), "right", "discarded watch pane freed its slot");
	if (agent.record.paneId) spent.panes.forgetTarget(agent.record.paneId);
	await spent.panes.acquire(cwd, "three");
	assert.equal(
		splitCalls(budget.execCalls).filter((args) => args[2] === "w1:p1").length,
		3,
		"forgotten agent pane freed its slot for the next helper",
	);
	budget.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(ok({}));
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	budget.waiters.find((waiter) => waiter.args.includes("done"))?.resolveWith(ok({}));
	await agent.completion;

	const mixed = createFakeCli();
	let nextPane = 1;
	mixed.respond("pane split", () => {
		nextPane += 1;
		const paneId = `w1:p${nextPane}`;
		return new Promise<CliResult>((resolve) => {
			setTimeout(
				() => resolve(ok({ result: { pane: { pane_id: paneId }, type: "pane_info" } })),
				25,
			);
		});
	});
	startAgent(mixed);
	const concurrent = wired(mixed);
	const agentLaunch = concurrent.registry.start({
		kind: "agent",
		command: "codex",
		cwd,
		label: "builder",
		prompt: "Work.",
		closeOnSettle: false,
	});
	await Promise.all([
		concurrent.panes.acquire(cwd, "watch-a"),
		agentLaunch,
		concurrent.panes.acquire(cwd, "watch-b"),
	]);
	const mixedCaller = splitCalls(mixed.execCalls).filter((args) => args[2] === "w1:p1");
	assert.ok(mixedCaller.length <= 2, "concurrent mixed fan-out cannot exceed two caller splits");
	assert.equal(
		mixedCaller.filter((args) => splitDirection(args) === "right").length,
		1,
		"mixed fan-out still only splits the caller right once",
	);
	mixed.waiters
		.filter((waiter) => waiter.args.includes("working"))
		.forEach((waiter) => waiter.resolveWith(ok({})));
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	mixed.waiters
		.filter((waiter) => waiter.args.includes("done"))
		.forEach((waiter) => waiter.resolveWith(ok({})));
	await (await agentLaunch).completion;
});

test("concurrent pane-manager acquires never issue two right splits of the caller", async () => {
	const fake = createFakeCli();
	let nextPane = 1;
	fake.respond("pane split", () => {
		nextPane += 1;
		const paneId = `w1:p${nextPane}`;
		return new Promise<CliResult>((resolve) => {
			setTimeout(
				() => resolve(ok({ result: { pane: { pane_id: paneId }, type: "pane_info" } })),
				25,
			);
		});
	});
	const { panes } = paneManagerOf(fake);
	const acquired = await Promise.all([
		panes.acquire(cwd, "one"),
		panes.acquire(cwd, "two"),
		panes.acquire(cwd, "three"),
	]);
	assert.equal(new Set(acquired.map((pane) => pane.paneId)).size, 3);
	const callerSplits = splitCalls(fake.execCalls).filter((args) => args[2] === "w1:p1");
	assert.ok(callerSplits.length <= 2, "concurrent acquire cannot exceed the caller budget");
	assert.equal(
		callerSplits.filter((args) => splitDirection(args) === "right").length,
		1,
		"only the first caller split is right",
	);
	assert.equal(splitCalls(fake.execCalls)[1]?.[2], acquired[0]?.paneId);
});

test("tall worker panes stack down via splitDirectionFor", async () => {
	const fake = createFakeCli();
	fake.respond("pane layout", (args) => {
		const paneId = args[args.indexOf("--pane") + 1] ?? "w1:p1";
		const rect =
			paneId === "w1:p1" ? { width: 120, height: 30 } : { width: 40, height: 80 };
		return ok({
			result: {
				layout: {
					panes: [{ pane_id: paneId, rect }],
				},
			},
		});
	});
	const { panes } = paneManagerOf(fake);
	const first = await panes.acquire(cwd, "wide-caller-split");
	await panes.acquire(cwd, "tall-worker");
	const splits = splitCalls(fake.execCalls);
	assert.equal(splits[0]?.[2], "w1:p1");
	assert.equal(splitDirection(splits[0]), "right");
	assert.equal(splits[1]?.[2], first.paneId, "second helper stacks off the worker");
	assert.equal(splitDirection(splits[1]), "down", "tall worker uses the down heuristic");
});

test("result artifact Status parsing strips markdown and classifies lifecycle signals", () => {
	assert.deepEqual(parseResultArtifactStatus("## Status\n**BLOCKED: needs approval.**\n# Claims\nx"), {
		line: "BLOCKED: needs approval",
		classification: "blocked",
	});
	assert.equal(parseResultArtifactStatus("# Status\n`IN_PROGRESS`\n")?.classification, "in-progress");
	assert.equal(parseResultArtifactStatus("# Status\nPASS\n")?.classification, "terminal");
});

test("a prompt to a working occupant queues without --wait and stays supervised", async () => {
	const fake = createFakeCli();
	fake.respond("agent get", () => agentGet("w1:p7", "reviewer-abc", "working", 7));
	const registry = herdrRegistry(fake);
	const { completion } = await registry.start({
		kind: "agent",
		command: "pi",
		cwd,
		prompt: "Queue this follow-up.",
		reuseName: "reviewer-abc",
	});
	assert.deepEqual(
		fake.execCalls.find((args) => args[0] === "agent" && args[1] === "prompt"),
		["agent", "prompt", "reviewer-abc", "Queue this follow-up."],
	);
	await waitUntil(() => fake.waiters.some((waiter) => waiter.args.includes("done")));
	fake.waiters.find((waiter) => waiter.args.includes("done"))?.resolveWith(ok({}));
	assert.equal((await completion).agentState, "done");
});

test("a prompt wait timeout remains supervised when the same occupant is working", async () => {
	const fake = createFakeCli();
	let gets = 0;
	fake.respond("agent get", () => {
		gets += 1;
		return agentGet("w1:p7", "reviewer-abc", gets < 3 ? "idle" : "working", gets);
	});
	fake.respond("agent prompt", () => failed("timeout", "timed out waiting for agent status"));
	const registry = herdrRegistry(fake);
	const { completion } = await registry.start({
		kind: "agent",
		command: "pi",
		cwd,
		prompt: "Submit once.",
		reuseName: "reviewer-abc",
	});
	assert.deepEqual(
		fake.execCalls.find((args) => args[0] === "agent" && args[1] === "prompt"),
		[
			"agent", "prompt", "reviewer-abc", "Submit once.", "--wait", "--until", "working",
			"--until", "done", "--until", "idle", "--until", "blocked", "--timeout", "20000",
		],
	);
	await waitUntil(() => fake.waiters.some((waiter) => waiter.args.includes("idle")));
	fake.waiters.find((waiter) => waiter.args.includes("idle"))?.resolveWith(ok({}));
	assert.equal((await completion).agentState, "idle");
});

test("a BLOCKED result artifact overrides Herdr done and keeps the pane open", async () => {
	const artifactDir = mkdtempSync(join(tmpdir(), "pi-detach-blocked-result-"));
	const artifactPath = join(artifactDir, "result.md");
	await writeFile(artifactPath, resultArtifact("**BLOCKED: needs approval.**"));
	try {
		const fake = createFakeCli();
		fake.respond("agent start", () => ok({ result: { agent: { pane_id: "w1:p7" } } }));
		const registry = herdrRegistry(fake);
		const { completion } = await registry.start({
			kind: "agent", command: "pi", cwd, prompt: "Work.", closeOnSettle: true,
			requiredArtifactPath: artifactPath,
		});
		fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(ok({}));
		await waitUntil(() => fake.waiters.some((waiter) => waiter.args.includes("done")));
		fake.waiters.find((waiter) => waiter.args.includes("done"))?.resolveWith(ok({}));
		const finished = await completion;
		assert.equal(finished.agentState, "blocked");
		assert.equal(finished.exitCode, 0);
		assert.equal(finished.resultStatus, "BLOCKED: needs approval");
		assert.equal(registry.list().find((run) => run.id === finished.id)?.resultStatus, "BLOCKED: needs approval");
		assert.match(registry.tail(finished.id, 10), /result artifact reports BLOCKED/);
		assert.deepEqual(closedPanes(fake.execCalls), []);
	} finally {
		await rm(artifactDir, { force: true, recursive: true });
	}
});

test("an IN PROGRESS artifact pauses once, rearms indefinitely, then settles terminal", async () => {
	for (const closeOnSettle of [true, false]) {
		const artifactDir = mkdtempSync(join(tmpdir(), "pi-detach-paused-result-"));
		const artifactPath = join(artifactDir, "result.md");
		await writeFile(artifactPath, resultArtifact("IN PROGRESS — waiting for tests"));
		try {
			const fake = createFakeCli();
			let agent = "";
			fake.respond("agent start", (args) => {
				agent = args[2] ?? "";
				return ok({ result: { agent: { pane_id: "w1:p7" } } });
			});
			fake.respond("agent get", () => agentGet("w1:p7", agent, "done", 2));
			const registry = herdrRegistry(fake);
			const progress: string[] = [];
			registry.onProgress((_record, note) => progress.push(note));
			const { record, completion } = await registry.start({
				kind: "agent", command: "pi", cwd, prompt: "Work.", closeOnSettle,
				requiredArtifactPath: artifactPath,
			});
			fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(ok({}));
			await waitUntil(() => fake.waiters.some((waiter) => waiter.args.includes("done")));
			fake.waiters.find((waiter) => waiter.args.includes("done"))?.resolveWith(ok({}));
			await waitUntil(() => progress.length === 1);
			assert.equal(record.status, "running");
			assert.match(progress[0] ?? "", /IN PROGRESS/);
			const workingWait = fake.waiters.filter((waiter) => waiter.args.includes("working")).at(-1);
			assert.equal(workingWait?.args.at(-1), "604800000", "pause rearms an indefinite working wait");
			assert.deepEqual(closedPanes(fake.execCalls), []);
			await writeFile(artifactPath, resultArtifact("PASS"));
			workingWait?.resolveWith(ok({}));
			await waitUntil(() => fake.waiters.filter((waiter) => waiter.args.includes("done")).length === 2);
			fake.waiters.filter((waiter) => waiter.args.includes("done")).at(-1)?.resolveWith(ok({}));
			const finished = await completion;
			assert.equal(finished.agentState, "done");
			assert.equal(finished.resultStatus, "PASS");
			assert.equal(progress.length, 1);
			await flushAsync();
			assert.equal(closedPanes(fake.execCalls).length, closeOnSettle ? 1 : 0);
		} finally {
			await rm(artifactDir, { force: true, recursive: true });
		}
	}
});

test("Pi role result discovery reads the agent session and supervises its artifact", async () => {
	const runDir = mkdtempSync(join(tmpdir(), "pi-detach-discovered-result-"));
	const sessionPath = join(runDir, "session.jsonl");
	const artifactPath = join(runDir, "result.md");
	await writeFile(sessionPath, [
		JSON.stringify({ type: "message", data: {} }),
		JSON.stringify({ type: "custom", customType: "advisor-worker", data: { runDir } }),
	].join("\n"));
	await writeFile(artifactPath, resultArtifact("PASS"));
	try {
		const fake = createFakeCli();
		let name = "";
		fake.respond("agent start", (args) => {
			name = args[2] ?? "";
			return ok({ result: { agent: { pane_id: "w1:p7" } } });
		});
		fake.respond("agent get", () => ok({ result: { agent: {
			pane_id: "w1:p7", name, agent_status: "idle", state_change_seq: 1,
			agent_session: { kind: "path", value: sessionPath },
		} } }));
		const registry = herdrRegistry(fake);
		const { record, completion } = await registry.start({
			kind: "agent", command: "pi", cwd, prompt: "Work.", resultDiscovery: "advisor-worker",
		});
		assert.equal(record.resultPath, artifactPath);
		assert.equal(registry.list()[0]?.resultPath, artifactPath);
		fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(ok({}));
		await waitUntil(() => fake.waiters.some((waiter) => waiter.args.includes("done")));
		fake.waiters.find((waiter) => waiter.args.includes("done"))?.resolveWith(ok({}));
		assert.equal((await completion).resultStatus, "PASS");
	} finally {
		await rm(runDir, { force: true, recursive: true });
	}
});

test("failed Pi result discovery preserves ordinary settlement and logs one note", async () => {
	const fake = createFakeCli();
	fake.respond("agent start", () => ok({ result: { agent: { pane_id: "w1:p7" } } }));
	const registry = herdrRegistry(fake);
	const { record, completion } = await registry.start({
		kind: "agent", command: "pi", cwd, prompt: "Work.", resultDiscovery: "advisor-worker",
	});
	assert.equal(record.resultPath, undefined);
	fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(ok({}));
	await waitUntil(() => fake.waiters.some((waiter) => waiter.args.includes("done")));
	fake.waiters.find((waiter) => waiter.args.includes("done"))?.resolveWith(ok({}));
	assert.equal((await completion).agentState, "done");
	assert.equal(registry.tail(record.id, 20).match(/could not discover/g)?.length, 1);
});

test("name reuse inherits the latest run result path", async () => {
	const artifactDir = mkdtempSync(join(tmpdir(), "pi-detach-reused-result-"));
	const artifactPath = join(artifactDir, "result.md");
	await writeFile(artifactPath, resultArtifact("PASS"));
	try {
		const fake = createFakeCli();
		fake.respond("agent get", () => agentGet("w1:p7", "reviewer-abc", "idle", 1));
		const registry = herdrRegistry(fake);
		const first = await registry.start({
			kind: "agent", command: "pi", cwd, prompt: "First.", reuseName: "reviewer-abc",
			requiredArtifactPath: artifactPath,
		});
		fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(ok({}));
		await waitUntil(() => fake.waiters.some((waiter) => waiter.args.includes("done")));
		fake.waiters.find((waiter) => waiter.args.includes("done"))?.resolveWith(ok({}));
		await first.completion;

		const second = await registry.start({
			kind: "agent", command: "pi", cwd, prompt: "Second.", reuseName: "reviewer-abc",
		});
		assert.equal(second.record.resultPath, artifactPath);
		fake.waiters.filter((waiter) => waiter.args.includes("working")).at(-1)?.resolveWith(ok({}));
		await waitUntil(() => fake.waiters.filter((waiter) => waiter.args.includes("done")).length === 2);
		fake.waiters.filter((waiter) => waiter.args.includes("done")).at(-1)?.resolveWith(ok({}));
		assert.equal((await second.completion).resultStatus, "PASS");
	} finally {
		await rm(artifactDir, { force: true, recursive: true });
	}
});
