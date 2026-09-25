import assert from "node:assert/strict";
import { test } from "node:test";
import { createHerdrDriver } from "../src/herdr/driver.ts";
import { createPaneManager } from "../src/herdr/panes.ts";
import type { CliResult, HerdrCli, Waiter } from "../src/herdr/cli.ts";
import type { RunController, RuntimeExecutionHooks } from "../src/types.ts";

const ok = (json: unknown = {}): CliResult => ({ ok: true, code: 0, stdout: "", stderr: "", json });

/**
 * Pi pane whose occupant is still launching for the first `pendingReads` `agent get`
 * calls, the way herdr 0.9 reports it: name and pane present, `launch_pending: true`,
 * no agent kind and no session. After that it reports a ready Pi occupant.
 */
function fixture(pendingReads: number, readyName?: string) {
    const calls: string[][] = [];
    const handles: Array<{ id: string; session: string }> = [];
    const recovered: string[] = [];
    let name = "";
    let gets = 0;
    let prompts = 0;
    const ready = () => ({
        pane_id: "w1:p2", name: readyName ?? name, agent: "pi", agent_status: "idle", state_change_seq: 3,
        agent_session: { source: "herdr:pi", agent: "pi", kind: "path", value: "/tmp/session.jsonl" },
    });
    const cli: HerdrCli = {
        async exec(args) {
            calls.push(args);
            if (args[0] === "pane" && args[1] === "split") return ok({ pane_id: "w1:p2" });
            if (args[1] === "process-info") return ok({ result: { process_info: { foreground_processes: [{ name: "zsh", argv0: "zsh" }] } } });
            if (args[1] === "start") { name = args[2]!; return ok({ result: { agent: { pane_id: "w1:p2", name, launch_pending: true } } }); }
            if (args[1] === "get") {
                gets++;
                return gets <= pendingReads
                    ? ok({ result: { agent: { pane_id: "w1:p2", name, launch_pending: true, agent_status: "unknown", state_change_seq: 0 } } })
                    : ok({ result: { agent: ready() } });
            }
            if (args[1] === "prompt") { prompts++; return ok(); }
            return ok();
        },
        spawnWaiter(args) {
            return { args, promise: new Promise<CliResult>(() => {}), kill() {} } as Waiter;
        },
    };
    const driver = createHerdrDriver({ cli, panes: createPaneManager(cli, { paneId: "w1:p1" }), ctx: { paneId: "w1:p1" }, env: {} });
    const hooks: RuntimeExecutionHooks = {
        environment: {}, assertActive() {},
        recordHandle(handle) { handles.push(handle); },
        settled() { return { terminal: true, close: false }; },
        recoveryRequired(cause) { recovered.push(cause ?? "unknown"); },
    };
    const controller: RunController = {
        record: { id: "launch-identity-1", kind: "agent", command: "pi", cwd: "/tmp", label: "identity", status: "running", backend: "herdr", startedAt: 0, promoted: false, logPath: "" },
        emitOutput() {}, finish() { throw new Error("legacy settlement forbidden"); },
    };
    return {
        launch: () => driver({ kind: "agent", command: "pi", cwd: "/tmp", prompt: "task", runtimeExecution: hooks, closeOnSettle: false }, controller),
        handles, recovered,
        gets: () => gets,
        prompts: () => prompts,
        closes: () => calls.filter(call => call[0] === "pane" && call[1] === "close").length,
    };
}

// Regression: herdr 0.9 answered `agent start` while the Pi occupant still reported
// `launch_pending`. The first identity read failed with BRIDGE_IDENTITY_UNAVAILABLE, the
// run went recovery-required, and a live Pi pane sat idle without ever receiving its task.
test("a fresh Pi launch waits for the occupant to publish its session, then submits the task once", async () => {
    const f = fixture(3);
    const handle = await f.launch();
    assert.ok(f.gets() > 3, "identity was read again after the pending reads");
    assert.equal(f.prompts(), 1);
    assert.equal(f.handles.length, 1);
    assert.match(f.handles[0]!.session, /session\.jsonl/);
    assert.deepEqual(f.recovered, []);
    assert.equal(f.closes(), 0);
    handle.detach?.();
});

test("a launching pane that turns out to hold a different occupant fails without input", async () => {
    const f = fixture(2, "someone-else");
    await assert.rejects(f.launch(), /BRIDGE_IDENTITY_UNAVAILABLE/);
    assert.equal(f.prompts(), 0);
});
