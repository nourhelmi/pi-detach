import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { CliResult, HerdrCli, Waiter } from "../src/herdr/cli.ts";
import { createHerdrDriver } from "../src/herdr/driver.ts";
import { createPaneManager } from "../src/herdr/panes.ts";
import { startMarker } from "../src/herdr/sentinel.ts";
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
		{ prefix: "pane send-keys", handler: () => ok({ result: { type: "ok" } }) },
		{ prefix: "pane read", handler: () => ok(undefined, "") },
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

function herdrRegistry(fake: ReturnType<typeof createFakeCli>) {
	const ctx = { paneId: "w1:p1" };
	const driver = createHerdrDriver({
		cli: fake.cli,
		ctx,
		panes: createPaneManager(fake.cli, ctx),
		env: { PI_DETACH_HERDR_TOAST: "0" },
	});
	return createRegistry(driver);
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

test("a herdr run completes through the sentinel wait", async () => {
	const fake = createFakeCli();
	const registry = herdrRegistry(fake);
	const { record, completion } = await registry.start({
		kind: "run",
		command: "bun test",
		cwd,
		label: "api tests",
	});
	assert.equal(record.backend, "herdr");
	assert.equal(record.paneId, "w1:p2");

	const paneRun = fake.execCalls.find((args) => args[0] === "pane" && args[1] === "run");
	assert.ok(paneRun, "typed the command into the pane");
	assert.match(paneRun?.[3] ?? "", /bun test/);
	assert.match(paneRun?.[3] ?? "", new RegExp(`<<pi-detach:${record.id}:start>>`));

	const waiter = fake.waiters.find((w) => w.args[0] === "wait" && w.args[1] === "output");
	assert.ok(waiter, "spawned a blocking output wait");
	waiter?.resolveWith(waitOutcome(record.id, 0, "42 tests passed"));

	const finished = await completion;
	assert.equal(finished.status, "exited");
	assert.equal(finished.exitCode, 0);
	assert.match(registry.tail(record.id, 10), /42 tests passed/);
	const rename = fake.execCalls.filter((args) => args[0] === "pane" && args[1] === "rename").at(-1);
	assert.match(rename?.[3] ?? "", /^✓ api tests/);
});

test("a failing herdr run carries its exit code", async () => {
	const fake = createFakeCli();
	const registry = herdrRegistry(fake);
	const { record, completion } = await registry.start({ kind: "run", command: "false", cwd });
	fake.waiters[0]?.resolveWith(waitOutcome(record.id, 3, "boom"));
	const finished = await completion;
	assert.equal(finished.exitCode, 3);
	assert.equal(finished.status, "exited");
});

test("a second run reuses the finished pane and prepends cd", async () => {
	const fake = createFakeCli();
	const registry = herdrRegistry(fake);
	const first = await registry.start({ kind: "run", command: "true", cwd });
	fake.waiters[0]?.resolveWith(waitOutcome(first.record.id, 0, ""));
	await first.completion;

	const second = await registry.start({ kind: "run", command: "bun lint", cwd: "/somewhere" });
	assert.equal(second.record.paneId, first.record.paneId);
	const splits = fake.execCalls.filter((args) => args[0] === "pane" && args[1] === "split");
	assert.equal(splits.length, 1, "no second split for the reused pane");
	const paneRuns = fake.execCalls.filter((args) => args[0] === "pane" && args[1] === "run");
	assert.match(paneRuns[1]?.[3] ?? "", /cd '\/somewhere' && bun lint/);
	fake.waiters[1]?.resolveWith(waitOutcome(second.record.id, 0, ""));
	await second.completion;
});

test("stopping a herdr run sends ctrl+c and settles as killed", async () => {
	const fake = createFakeCli();
	const registry = herdrRegistry(fake);
	const { record, completion } = await registry.start({ kind: "run", command: "sleep 999", cwd });
	registry.stop(record.id);
	const finished = await completion;
	assert.equal(finished.status, "killed");
	const keys = fake.execCalls.find((args) => args[0] === "pane" && args[1] === "send-keys");
	assert.deepEqual(keys?.slice(2), [record.paneId, "ctrl+c"]);
});

test("falls back to the local backend when herdr refuses to split", async () => {
	const fake = createFakeCli();
	fake.respond("pane layout", () => failed("not_found"));
	fake.respond("pane split", () => failed("not_found", "pane not found"));
	const registry = herdrRegistry(fake);
	const { record, completion } = await registry.start({
		kind: "run",
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
	});
	assert.equal(record.paneId, "w1:p7");
	assert.match(record.agentName ?? "", /^reviewer-/);

	const prompted = fake.execCalls.find((args) => args[0] === "pane" && args[1] === "run");
	assert.equal(prompted?.[3], "Review the diff.");

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
	const blocked = fake.waiters.find((w) => w.args.includes("blocked"));
	assert.equal(blocked?.killedByDriver, true, "loser waits are cancelled");
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
	});
	fake.waiters.find((w) => w.args.includes("working"))?.resolveWith(ok({}));
	await new Promise((r) => setTimeout(r, 20));
	fake.waiters.find((w) => w.args.includes("blocked"))?.resolveWith(ok({}));
	const finished = await completion;
	assert.equal(finished.agentState, "blocked");
	assert.match(registry.tail(record.id, 5), /rm -rf dist/);
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
	fake.waiters.find((w) => w.args.includes("working"))?.resolveWith(ok({}));
	await new Promise((r) => setTimeout(r, 20));
	fake.waiters.find((w) => w.args.includes("idle"))?.resolveWith(ok({}));
	const finished = await completion;
	assert.equal(finished.agentState, "idle");
});
