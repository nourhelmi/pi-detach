import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CliResult, HerdrCli, Waiter } from "../src/herdr/cli.ts";
import { createHerdrDriver } from "../src/herdr/driver.ts";
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
	waiters: FakeWaiter[];
	respond: (prefix: string, handler: (args: string[]) => CliResult) => void;
} {
	const execCalls: string[][] = [];
	const waiters: FakeWaiter[] = [];
	const routes: { prefix: string; handler: (args: string[]) => CliResult }[] = [];
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
		exec(args) {
			execCalls.push(args);
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
		waiters,
		respond: (prefix, handler) => routes.push({ prefix, handler }),
	};
}

function herdrRegistry(
	fake: ReturnType<typeof createFakeCli>,
	extras: {
		ledger?: ReturnType<typeof createSessionLedger>;
		reapOrphans?: () => Promise<void>;
	} = {},
) {
	const ctx = { paneId: "w1:p1", tabId: "w1:t7", workspaceId: "w1" };
	const panes = createPaneManager(fake.cli, ctx);
	const driver = createHerdrDriver({
		cli: fake.cli,
		ctx,
		panes,
		env: { PI_DETACH_HERDR_TOAST: "0" },
		...(extras.ledger ? { ledger: extras.ledger } : {}),
		...(extras.reapOrphans ? { reapOrphans: extras.reapOrphans } : {}),
	});
	const viewer = createViewerManager(fake.cli, panes);
	return createRegistry({ herdrDriver: driver, onPromoted: viewer.attach });
}

function flushAsync(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
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
	const registry = herdrRegistry(fake);
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
	const advisorSplit = fake.execCalls.find(
		(args) => args[0] === "pane" && args[1] === "split" && args[2] === "w1:p1",
	);
	assert.equal(
		advisorSplit?.[advisorSplit.indexOf("--direction") + 1],
		"right",
		"wide advisor splits right",
	);
	assert.ok(advisorSplit?.includes("--no-focus"), "advisor retains focus");

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
	const done = fake.waiters.find((w) => w.args.includes("done"));
	assert.ok(done, "races a wait on done");
	done?.resolveWith(ok({ event: "pane.agent_status_changed" }));

	const finished = await completion;
	assert.equal(finished.agentState, "done");
	assert.equal(finished.status, "exited");
	assert.match(registry.tail(record.id, 10), /I finished the review/);
	assert.ok(
		fake.execCalls.some((args) => args[0] === "pane" && args[1] === "close" && args[2] === "w1:p7"),
		"successful agent pane closes after its transcript is captured",
	);
	const blocked = fake.waiters.find((w) => w.args.includes("blocked"));
	assert.equal(blocked?.killedByDriver, true, "loser waits are cancelled");
});

test("agent start retries Herdr's transient unavailable-shell refusal", async () => {
	const fake = createFakeCli();
	let starts = 0;
	fake.respond("agent start", () => {
		starts += 1;
		if (starts < 3) {
			return failed(
				"invalid_state",
				"agent target pane w1:p2 is not an available shell",
			);
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
	const prompt = "/skill:advisor-role-scout ROLE: scout\n\nTASK: inspect";
	const { record, completion } = await registry.start({
		kind: "agent",
		command: "pi --model gpt-5.6-sol",
		cwd,
		prompt,
	});
	const prompted = fake.execCalls.find((args) => args[0] === "agent" && args[1] === "prompt");
	assert.equal(prompted?.[2], record.agentName, "prompt targets the agent by name");
	assert.equal(prompted?.[3], prompt, "full multiline prompt in one atomic submit");
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

test("the advisor pane is split at most twice; further agents stack off worker panes", async () => {
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
	const advisorSplits = fake.execCalls.filter(
		(args) => args[0] === "pane" && args[1] === "split" && args[2] === "w1:p1",
	);
	assert.equal(advisorSplits.length, 2, "the advisor pane is split at most twice");
	const workerSplit = fake.execCalls.find(
		(args) => args[0] === "pane" && args[1] === "split" && args[2] === records[1]?.paneId,
	);
	assert.ok(workerSplit, "third agent splits off the newest worker pane");
	for (const waiter of fake.waiters.filter((w) => w.args.includes("done"))) {
		waiter.resolveWith(ok({ event: "pane.agent_status_changed" }));
	}
	await Promise.all(completions);
});

test("parallel agent starts preserve the advisor split cap", async () => {
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
	const advisorSplits = fake.execCalls.filter(
		(args) => args[0] === "pane" && args[1] === "split" && args[2] === "w1:p1",
	);
	assert.equal(advisorSplits.length, 2, "parallel launches still cap direct advisor splits");
	const workerSplit = fake.execCalls.find(
		(args) => args[0] === "pane" && args[1] === "split" && args[2] === records[1]?.paneId,
	);
	assert.ok(workerSplit, "the third parallel agent splits off a worker pane");
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
	const { completion } = await registry.start({
		kind: "agent",
		command: "codex",
		cwd,
		label: "reviewer",
		prompt: "Review.",
		closeOnSettle: true,
	});
	fake.waiters.find((waiter) => waiter.args.includes("working"))?.resolveWith(ok({}));
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
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
