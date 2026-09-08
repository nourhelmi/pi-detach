import assert from "node:assert/strict";
import { test } from "node:test";
import { createHerdrDriver } from "../src/herdr/driver.ts";
import { createPaneManager } from "../src/herdr/panes.ts";
import type { CliResult, HerdrCli, Waiter } from "../src/herdr/cli.ts";
import type { RunController, RuntimeExecutionHooks } from "../src/types.ts";

const ok = (json: unknown = {}): CliResult => ({ ok: true, code: 0, stdout: "", stderr: "", json });
function fixture() {
    const calls: string[][] = [];
    const waiters: Array<Waiter & { resolve: (result: CliResult) => void; args: string[] }> = [];
    const agent: any = { pane_id: "w1:p2", name: "", agent: "codex", terminal_id: "terminal-1", state_change_seq: 1, agent_status: "idle" };
    const process: any = { pane_id: agent.pane_id, shell_pid: 10, foreground_process_group_id: 20, foreground_processes: [{ name: "codex", argv0: "codex", pid: 21 }] };
    let started = false, prompts = 0, recovered = 0, settled = 0;
    let bound: { id: string; session: string } | undefined;
    let onGet = () => {};
    let promptFails = false;
    const provider = (value = "thread-1") => { agent.agent_session = { source: "herdr:codex", agent: "codex", kind: "id", value }; };
    const cli: HerdrCli = {
        async exec(args) {
            calls.push(args);
            if (args[0] === "pane" && args[1] === "split") return ok({ pane_id: agent.pane_id });
            if (args[1] === "process-info") return ok({ result: { process_info: started ? process : { foreground_processes: [{ name: "zsh", argv0: "zsh" }] } } });
            if (args[1] === "start") { started = true; agent.name = args[2]; return ok({ result: { agent } }); }
            if (args[1] === "get") { onGet(); return ok({ result: { agent } }); }
            if (args[1] === "prompt") {
                assert.ok(bound, "persist qualified transport handle BEFORE prompt");
                assert.ok(bound.session.includes("herdr-codex-process"));
                prompts++;
                agent.state_change_seq++; agent.agent_status = "working";
                if (promptFails) return { ...ok(), ok: false, code: 1 };
            }
            return ok();
        },
        spawnWaiter(args) {
            let resolve!: (result: CliResult) => void;
            const promise = new Promise<CliResult>(done => { resolve = done; });
            const waiter = { args, promise, resolve, kill() {} };
            waiters.push(waiter); return waiter;
        },
    };
    const deps = { cli, panes: createPaneManager(cli, { paneId: "w1:p1" }), ctx: { paneId: "w1:p1" }, env: {} };
    const driver = createHerdrDriver(deps);
    const launch = (followup = false, useDriver = driver) => {
        const hooks: RuntimeExecutionHooks = {
            environment: {}, assertActive() {},
            ...(followup ? { expectedHandle: bound!, expectedGeneration: agent.state_change_seq } : {}),
            recordHandle(handle) { if (bound) assert.deepEqual(handle, bound); bound = handle; },
            settled() { settled++; return true; }, recoveryRequired() { recovered++; },
        };
        const controller: RunController = {
            record: { id: "test-native-1", kind: "agent", command: "codex", cwd: "/tmp", label: "native", status: "running", backend: "herdr", startedAt: 0, promoted: false, logPath: "" },
            emitOutput() {}, finish() { throw new Error("legacy settlement forbidden"); },
        };
        return useDriver({ kind: "agent", command: "codex", cwd: "/tmp", prompt: "bounded task", runtimeExecution: hooks, closeOnSettle: false }, controller);
    };
    return {
        agent, process, calls, provider, launch, newDriver: () => createHerdrDriver(deps),
        onGet(fn: () => void) { onGet = fn; }, failPrompt() { promptFails = true; },
        counts: () => ({ prompts, recovered, settled }),
        async finish() {
            agent.state_change_seq++; agent.agent_status = "done";
            waiters.splice(0).filter(w => w.args[4] === "done").forEach(w => w.resolve(ok()));
            await new Promise(resolve => setImmediate(resolve));
        },
    };
}

test("Codex binds without a thread, pins its arriving session, and reuses the same handle", async () => {
    const f = fixture();
    const first = await f.launch();
    assert.equal(f.agent.agent_session, undefined);
    f.provider(); await f.finish();
    assert.deepEqual(f.counts(), { prompts: 1, recovered: 0, settled: 1 });
    await f.launch(true); await f.finish();
    await f.launch(true); await f.finish();
    assert.deepEqual(f.counts(), { prompts: 3, recovered: 0, settled: 3 });
    assert.equal(f.calls.filter(c => c[1] === "start").length, 1);
    first.detach?.();
});

for (const [name, mutate] of Object.entries({
    terminal: (f: ReturnType<typeof fixture>) => { f.agent.terminal_id = "replacement"; },
    name: (f: ReturnType<typeof fixture>) => { f.agent.name = "replacement"; },
    pane: (f: ReturnType<typeof fixture>) => { f.agent.pane_id = "w1:p3"; },
    process: (f: ReturnType<typeof fixture>) => { f.process.foreground_processes[0].pid++; },
    shell: (f: ReturnType<typeof fixture>) => { f.process.shell_pid++; },
    group: (f: ReturnType<typeof fixture>) => { f.process.foreground_process_group_id++; },
    thread: (f: ReturnType<typeof fixture>) => { f.provider("replacement"); },
    missingThread: (f: ReturnType<typeof fixture>) => { delete f.agent.agent_session; },
    agentKind: (f: ReturnType<typeof fixture>) => { f.agent.agent = "pi"; },
    sequence: (f: ReturnType<typeof fixture>) => { f.agent.state_change_seq = -1; },
})) {
    test(`Codex rejects ${name} drift before follow-up input`, async () => {
        const f = fixture(); await f.launch(); f.provider(); await f.finish();
        mutate(f);
        await assert.rejects(f.launch(true), /BRIDGE_(HANDLE_MISMATCH|IDENTITY_UNAVAILABLE)/);
        assert.equal(f.counts().prompts, 1);
        assert.equal(f.calls.some(c => c[1] === "send-keys" || c[1] === "close"), false);
    });
}

test("Codex missing session at settlement requires recovery, not a fabricated PASS", async () => {
    const f = fixture(); await f.launch(); await f.finish();
    assert.deepEqual(f.counts(), { prompts: 1, recovered: 1, settled: 0 });
});

test("Codex process drift fences live output and Escape", async () => {
    const f = fixture(); const handle = await f.launch(); f.process.foreground_processes[0].pid++;
    await assert.rejects(handle.readLive!(10), /BRIDGE_HANDLE_MISMATCH/);
    await assert.rejects(handle.interrupt!(), /BRIDGE_HANDLE_MISMATCH/);
    assert.equal(f.calls.some(c => c[1] === "send-keys" || c[1] === "read"), false);
    handle.detach?.();
});

test("Codex prompt ambiguity never retries or sends Enter", async () => {
    const f = fixture(); f.failPrompt();
    await assert.rejects(f.launch(), /BRIDGE_PROMPT_AMBIGUOUS/);
    assert.equal(f.counts().prompts, 1);
    assert.equal(f.calls.some(c => c[1] === "send-keys"), false);
});

test("Codex never adopts an existing handle into a fresh driver", async () => {
    const f = fixture(); await f.launch(); f.provider(); await f.finish();
    await assert.rejects(f.launch(true, f.newDriver()), /BRIDGE_HANDLE_MISMATCH/);
    assert.equal(f.counts().prompts, 1);
});

for (const bad of ["blocked", "working", "unknown"]) {
    test(`Codex ${bad} UI receives no input`, async () => {
        const f = fixture(); f.agent.agent_status = bad;
        await assert.rejects(f.launch(), /BRIDGE_AGENT_NOT_IDLE/);
        assert.equal(f.counts().prompts, 0);
    });
}

test("Codex pre-submission generation drift receives no input", async () => {
    const f = fixture(); let gets = 0;
    f.onGet(() => { if (++gets === 2) f.agent.state_change_seq++; });
    await assert.rejects(f.launch(), /BRIDGE_HANDLE_MISMATCH/);
    assert.equal(f.counts().prompts, 0);
});

test("Codex missing or ambiguous native process identity receives no input", async () => {
    for (const processes of [[], [{ name: "codex", argv0: "codex", pid: 0 }], [{ name: "codex", argv0: "codex", pid: 21 }, { name: "codex", argv0: "codex", pid: 22 }]]) {
        const f = fixture(); f.process.foreground_processes = processes;
        await assert.rejects(f.launch(), /BRIDGE_IDENTITY_UNAVAILABLE/);
        assert.equal(f.counts().prompts, 0);
    }
});
