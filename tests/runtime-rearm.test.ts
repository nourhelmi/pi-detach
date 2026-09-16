import assert from "node:assert/strict";
import { test } from "node:test";
import { createHerdrDriver } from "../src/herdr/driver.ts";
import { createPaneManager } from "../src/herdr/panes.ts";
import type { CliResult, HerdrCli, Waiter } from "../src/herdr/cli.ts";
import type { RunController, RuntimeExecutionHooks, SettledOutcome } from "../src/types.ts";

const ok = (json: unknown = {}): CliResult => ({ ok: true, code: 0, stdout: "", stderr: "", json });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!condition()) { assert.ok(Date.now() < deadline, "condition not reached"); await sleep(10); }
}

/** Pi occupant whose runtime settled() verdicts are scripted per observed turn. */
function fixture(verdicts: Array<SettledOutcome | Promise<SettledOutcome>>, closeOnSettle = true) {
    const calls: string[][] = [];
    const agent: any = { pane_id: "w1:p2", name: "", agent: "pi", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-1" }, state_change_seq: 1, agent_status: "idle" };
    const waiters: Array<{ args: string[]; open: boolean; resolve: (result: CliResult) => void }> = [];
    const settledCalls: Array<{ state: string; generation: number }> = [];
    const recovered: string[] = [];
    const cli: HerdrCli = {
        async exec(args) {
            calls.push(args);
            if (args[0] === "pane" && args[1] === "split") return ok({ pane_id: agent.pane_id });
            if (args[1] === "process-info") return ok({ result: { process_info: { foreground_processes: [{ name: "zsh", argv0: "zsh" }] } } });
            if (args[1] === "start") { agent.name = args[2]; return ok({ result: { agent } }); }
            if (args[1] === "get") return ok({ result: { agent } });
            if (args[1] === "prompt") { agent.state_change_seq++; agent.agent_status = "working"; return ok(); }
            if (args[1] === "read") return { ...ok(), stdout: "pane output" };
            return ok();
        },
        spawnWaiter(args) {
            let resolve!: (result: CliResult) => void;
            const promise = new Promise<CliResult>(done => { resolve = done; });
            const waiter = { args, open: true, resolve(result: CliResult) { waiter.open = false; resolve(result); } };
            waiters.push(waiter);
            return { args, promise, kill() { waiter.resolve({ ...ok(), ok: false, errorCode: "cancelled" }); } } as Waiter;
        },
    };
    const driver = createHerdrDriver({ cli, panes: createPaneManager(cli, { paneId: "w1:p1" }), ctx: { paneId: "w1:p1" }, env: {} });
    const hooks: RuntimeExecutionHooks = {
        environment: {}, childrenSettled: async () => true, assertActive() {}, recordHandle() {},
        settled(state, _output, generation) {
            settledCalls.push({ state, generation });
            const next = verdicts.shift(); assert.ok(next, "unscripted settlement");
            return next;
        },
        recoveryRequired(cause) { recovered.push(cause ?? "unknown"); },
    };
    const controller: RunController = {
        record: { id: "rearm-1", kind: "agent", command: "pi", cwd: "/tmp", label: "rearm", status: "running", backend: "herdr", startedAt: 0, promoted: false, logPath: "" },
        emitOutput() {}, finish() { throw new Error("legacy settlement forbidden"); },
    };
    const pending = (state: string) => waiters.filter(waiter => waiter.open && waiter.args[3] === "--until" && waiter.args[4] === state);
    return {
        agent, settledCalls, recovered, pending,
        driver: () => driver({ kind: "agent", command: "pi", cwd: "/tmp", prompt: "task", runtimeExecution: hooks, closeOnSettle }, controller),
        settle(state: "done" | "idle") { agent.agent_status = state; agent.state_change_seq++; for (const waiter of pending(state)) waiter.resolve(ok()); },
        work() { agent.agent_status = "working"; agent.state_change_seq++; for (const waiter of pending("working")) waiter.resolve(ok()); },
        closes: () => calls.filter(call => call[0] === "pane" && call[1] === "close").length,
    };
}

test("a held turn waits for the next lifecycle change and settles on the following turn", async () => {
    const f = fixture([{ terminal: false, close: false, rearm: true }, { terminal: true, close: true }]);
    await f.driver();
    await until(() => f.pending("done").length === 1);
    f.settle("done");
    await until(() => f.pending("working").length === 1);
    assert.deepEqual(f.settledCalls, [{ state: "done", generation: 3 }]);
    assert.equal(f.pending("done").length, 0, "settled waits are not re-armed while the occupant is parked at its composer");
    assert.equal(f.closes(), 0, "a held turn never closes the pane");
    f.work();
    await until(() => f.pending("done").length === 1);
    f.settle("idle");
    await until(() => f.settledCalls.length === 2);
    assert.deepEqual(f.settledCalls[1], { state: "idle", generation: 5 });
    await until(() => f.closes() === 1);
    assert.deepEqual(f.recovered, []);
});

test("a held turn whose occupant already finished its next turn settles without a working wait", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture([gate.then(() => ({ terminal: false, close: false, rearm: true })), { terminal: true, close: false }], false);
    await f.driver();
    await until(() => f.pending("done").length === 1);
    f.settle("done");
    await until(() => f.settledCalls.length === 1);
    // Woken and finished again while the runtime was still deciding the first verdict.
    f.agent.agent_status = "working"; f.agent.state_change_seq++;
    f.agent.agent_status = "done"; f.agent.state_change_seq++;
    release();
    await until(() => f.settledCalls.length === 2);
    assert.deepEqual(f.settledCalls[1], { state: "done", generation: 5 });
    assert.equal(f.pending("working").length, 0, "no working wait when the occupant already moved on");
    assert.equal(f.closes(), 0);
    assert.deepEqual(f.recovered, []);
});

test("a held turn observed at a stale generation is recovery, never a fabricated settlement", async () => {
    const f = fixture([{ terminal: false, close: false, rearm: true }]);
    await f.driver();
    await until(() => f.pending("done").length === 1);
    f.settle("done");
    await until(() => f.pending("working").length === 1);
    // The working wait fires but the occupant reports no newer generation: ambiguous, not settled.
    for (const waiter of f.pending("working")) waiter.resolve(ok());
    await until(() => f.pending("done").length === 1);
    for (const waiter of f.pending("done")) waiter.resolve(ok());
    await until(() => f.recovered.length === 1);
    assert.deepEqual(f.recovered, ["BRIDGE_STALE_SETTLEMENT"]);
    assert.equal(f.settledCalls.length, 1);
});
