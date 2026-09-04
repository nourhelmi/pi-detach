import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeRunState } from "../src/run-state.ts";
test("atomically writes pi-detach-owned projection", async () => { const dir = await mkdtemp(join(tmpdir(), "run-state-")); const path = join(dir, "state.json"); await writeRunState({ id: "r1", kind: "agent", command: "pi", cwd: dir, label: "worker", status: "running", backend: "bb", surface: { kind: "bb", threadId: "t", logicalParentThreadId: "p", hostId: "h" }, startedAt: 1, promoted: true, logPath: join(dir, "output.log"), resultPath: join(dir, "result.md"), agentState: "blocked" }, "paused", path); const value = JSON.parse(await readFile(path, "utf8")); assert.equal(value.transportState, "paused"); assert.equal(value.settlementDecision, "pause"); assert.equal(value.label, "worker"); assert.equal(value.surface.threadId, "t"); });
