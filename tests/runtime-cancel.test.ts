import assert from "node:assert/strict";
import { test } from "node:test";
import { createHerdrDriver } from "../src/herdr/driver.ts";
import { createPaneManager } from "../src/herdr/panes.ts";
import type { CliResult, HerdrCli, Waiter } from "../src/herdr/cli.ts";
import type { InterruptObserver, RunController, RuntimeExecutionHooks } from "../src/types.ts";

const ok = (json: unknown = {}): CliResult => ({ ok: true, code: 0, stdout: "", stderr: "", json });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!condition()) { assert.ok(Date.now() < deadline, "condition not reached"); await sleep(20); }
}

/** Pi occupant that starts working after its prompt; Escape alone changes nothing until the fixture settles it. */
function fixture() {
    const calls: string[][] = [];
    const agent: any = { pane_id: "w1:p2", name: "", agent: "pi", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-1" }, state_change_seq: 1, agent_status: "idle" };
    const waiters: Array<{ args: string[]; resolve: (result: CliResult) => void }> = [];
    let escFails = false; let swapOnEscape = false; let getDelay = 0; let settled = 0; let recovered = 0;
    const cli: HerdrCli = {
        async exec(args) {
            calls.push(args);
            if (args[0] === "pane" && args[1] === "split") return ok({ pane_id: agent.pane_id });
            if (args[1] === "process-info") return ok({ result: { process_info: { foreground_processes: [{ name: "zsh", argv0: "zsh" }] } } });
            if (args[1] === "start") { agent.name = args[2]; return ok({ result: { agent } }); }
            if (args[1] === "get") { if (getDelay) { const delay = getDelay; getDelay = 0; await sleep(delay); } return ok({ result: { agent } }); }
            if (args[1] === "prompt") { agent.state_change_seq++; agent.agent_status = "working"; return ok(); }
            if (args[1] === "send-keys") { if (swapOnEscape) agent.agent_session.value = "replacement"; return escFails ? { ...ok(), ok: false, code: 1 } : ok(); }
            if (args[1] === "read") return { ...ok(), stdout: "pane output" };
            return ok();
        },
        spawnWaiter(args) {
            let resolve!: (result: CliResult) => void;
            const promise = new Promise<CliResult>(done => { resolve = done; });
            waiters.push({ args, resolve });
            return { args, promise, kill() {} } as Waiter;
        },
    };
    const driver = createHerdrDriver({ cli, panes: createPaneManager(cli, { paneId: "w1:p1" }), ctx: { paneId: "w1:p1" }, env: {} });
    const hooks: RuntimeExecutionHooks = { environment: {}, assertActive() {}, recordHandle() {}, settled() { settled++; return { terminal: true, close: true }; }, recoveryRequired() { recovered++; } };
    const controller: RunController = {
        record: { id: "cancel-1", kind: "agent", command: "pi", cwd: "/tmp", label: "cancel", status: "running", backend: "herdr", startedAt: 0, promoted: false, logPath: "" },
        emitOutput() {}, finish() { throw new Error("legacy settlement forbidden"); },
    };
    const observed: Array<{ state: string; output: string; generation: number }> = []; let observerRecovery = 0; let superseded = 0;
    const observer: InterruptObserver = { settled(state, output, generation) { observed.push({ state, output, generation }); }, superseded() { superseded++; }, recoveryRequired() { observerRecovery++; } };
    return {
        agent, calls, observer, observed, driver: () => driver({ kind: "agent", command: "pi", cwd: "/tmp", prompt: "task", runtimeExecution: hooks, closeOnSettle: false }, controller),
        failEscape() { escFails = true; }, swapOnEscape() { swapOnEscape = true; }, delayNextGet(ms: number) { getDelay = ms; },
        naturalDone() { agent.agent_status = "done"; agent.state_change_seq++; for (const waiter of waiters.splice(0)) if (waiter.args[4] === "done") waiter.resolve(ok()); },
        counts: () => ({ settled, recovered, observerRecovery, superseded }),
        escapes: () => calls.filter(c => c[1] === "send-keys" && c[3] === "esc").length,
    };
}

test("cancellation settles only after the same occupant is observed idle following Escape", async () => {
    const f = fixture(); const handle = await f.driver();
    await handle.interrupt!(f.observer);
    assert.equal(f.escapes(), 1);
    await sleep(60);
    assert.deepEqual(f.observed, [], "a still-working agent is cancel-pending, not cancelled");
    f.agent.agent_status = "idle"; f.agent.state_change_seq++;
    await until(() => f.observed.length === 1);
    assert.deepEqual(f.observed[0], { state: "idle", output: "pane output", generation: f.agent.state_change_seq });
    assert.deepEqual(f.counts(), { settled: 0, recovered: 0, observerRecovery: 0, superseded: 0 }, "the launch observer never reports the interrupted turn as done");
    assert.equal(f.calls.some(c => c[1] === "close"), false, "cancellation never closes the pane");
});

test("an occupant already at its composer confirms cancellation from a post-Escape observation", async () => {
    const f = fixture(); const handle = await f.driver();
    f.agent.agent_status = "idle"; f.agent.state_change_seq++;
    const generation = f.agent.state_change_seq;
    const getsBefore = f.calls.filter(c => c[1] === "get").length;
    await handle.interrupt!(f.observer);
    await until(() => f.observed.length === 1);
    assert.equal(f.observed[0]!.generation, generation);
    const escapeIndex = f.calls.findIndex(c => c[1] === "send-keys");
    assert.ok(f.calls.slice(escapeIndex + 1).some(c => c[1] === "get"), "settlement comes from an observation taken after Escape");
    assert.ok(f.calls.filter(c => c[1] === "get").length >= getsBefore + 2);
});

test("a replacement occupant during Escape is never reported cancelled", async () => {
    const f = fixture(); const handle = await f.driver();
    f.agent.agent_status = "idle"; f.agent.state_change_seq++;
    f.swapOnEscape();
    await handle.interrupt!(f.observer);
    await until(() => f.counts().observerRecovery === 1);
    assert.deepEqual(f.observed, []);
    assert.equal(f.escapes(), 1);
});

test("identity drift while waiting for cancellation settlement requires recovery", async () => {
    const f = fixture(); const handle = await f.driver();
    await handle.interrupt!(f.observer);
    f.agent.agent_session.value = "replacement"; f.agent.agent_status = "idle"; f.agent.state_change_seq++;
    await until(() => f.counts().observerRecovery === 1);
    assert.deepEqual(f.observed, []);
});

test("a turn that settled naturally before cancellation began is superseded, never re-reported", async () => {
    const f = fixture(); const handle = await f.driver();
    f.naturalDone();
    await until(() => f.counts().settled === 1);
    await handle.interrupt!(f.observer);
    assert.deepEqual(f.counts(), { settled: 1, recovered: 0, observerRecovery: 0, superseded: 1 });
    assert.equal(f.escapes(), 0, "no Escape is sent to a finished turn");
    assert.deepEqual(f.observed, []);
});

test("a cancellation that begins first fences the natural settlement even when its own observation is delayed", async () => {
    const f = fixture(); const handle = await f.driver();
    f.delayNextGet(80);
    const interrupting = handle.interrupt!(f.observer);
    f.naturalDone();
    await interrupting;
    await until(() => f.observed.length === 1);
    assert.equal(f.observed[0]!.state, "done");
    assert.deepEqual(f.counts(), { settled: 0, recovered: 0, observerRecovery: 0, superseded: 0 }, "exactly one settlement path wins");
    assert.equal(f.escapes(), 1);
});

test("a failed Escape is ambiguous: no observer, no retry, no settlement", async () => {
    const f = fixture(); const handle = await f.driver(); f.failEscape();
    await assert.rejects(handle.interrupt!(f.observer), /BRIDGE_CANCEL_AMBIGUOUS/);
    f.agent.agent_status = "idle"; f.agent.state_change_seq++;
    await sleep(60);
    assert.deepEqual(f.observed, []); assert.equal(f.escapes(), 1);
});

test("interrupt without an observer keeps the legacy fire-and-forget contract", async () => {
    const f = fixture(); const handle = await f.driver();
    await handle.interrupt!();
    f.agent.agent_status = "idle"; f.agent.state_change_seq++;
    await sleep(60);
    assert.deepEqual(f.observed, []); assert.equal(f.counts().settled, 0);
});
