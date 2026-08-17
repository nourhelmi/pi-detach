/**
 * @file orphan-reaper.test.ts — session-ledger reaper against the fake herdr CLI.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CliResult, HerdrCli, Waiter } from "../src/herdr/cli.ts";
import {
	createSessionLedger,
	ledgerFilePath,
	type AgentPaneLedgerRecord,
	type SessionLedgerFile,
} from "../src/herdr/ledger.ts";
import {
	createSafeReap,
	isProcessAlive,
	MIN_RECORD_AGE_MS,
	reapOrphanAgentPanes,
} from "../src/herdr/reaper.ts";

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

function createFakeCli(): {
	cli: HerdrCli;
	execCalls: string[][];
	respond: (prefix: string, handler: (args: string[]) => CliResult) => void;
} {
	const execCalls: string[][] = [];
	const routes: { prefix: string; handler: (args: string[]) => CliResult }[] = [];
	const cli: HerdrCli = {
		exec(args) {
			execCalls.push(args);
			const key = args.join(" ");
			for (const route of routes) {
				if (key.startsWith(route.prefix)) return Promise.resolve(route.handler(args));
			}
			return Promise.resolve(failed("not_scripted", key));
		},
		spawnWaiter(): Waiter {
			return { promise: Promise.resolve(failed("unused")), kill() {} };
		},
	};
	return {
		cli,
		execCalls,
		respond: (prefix, handler) => routes.push({ prefix, handler }),
	};
}

function seed(
	dir: string,
	sessionId: string,
	ownerPid: number,
	records: Array<Partial<AgentPaneLedgerRecord> & Pick<AgentPaneLedgerRecord, "paneId" | "agentName">>,
): void {
	const file: SessionLedgerFile = {
		sessionId,
		ownerPid,
		records: records.map((record) => ({
			paneId: record.paneId,
			agentName: record.agentName,
			runId: record.runId ?? "run-1",
			label: record.label ?? record.agentName,
			closeOnSettle: record.closeOnSettle ?? true,
			ownerPid: record.ownerPid ?? ownerPid,
			createdAt: record.createdAt ?? 1,
		})),
	};
	writeFileSync(ledgerFilePath(dir, sessionId), `${JSON.stringify(file, null, "\t")}\n`);
}

function agentInfo(
	paneId: string,
	name: string,
	agent_status: string,
	state_change_seq = 1,
): CliResult {
	return ok({
		result: {
			agent: { pane_id: paneId, name, agent_status, state_change_seq },
			type: "agent_info",
		},
	});
}

function leftover(dir: string, sessionId: string): AgentPaneLedgerRecord[] {
	return createSessionLedger({ ledgerDir: dir, sessionId, ownerPid: 1 }).read().records;
}

function paneGets(execCalls: string[][]): string[] {
	return execCalls.filter((args) => args[0] === "agent" && args[1] === "get").map((args) => args[2] ?? "");
}

function closedPanes(execCalls: string[][]): string[] {
	return execCalls.filter((args) => args[0] === "pane" && args[1] === "close").map((args) => args[2] ?? "");
}

test("dead-PID + settled closes the pane and drops the record", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-detach-reaper-"));
	seed(dir, "dead-sess", 999001, [
		{ paneId: "w4:p9", agentName: "e2e-verifier-ab12", closeOnSettle: true },
	]);
	const fake = createFakeCli();
	fake.respond("agent get", () => agentInfo("w4:p9", "e2e-verifier-ab12", "idle"));
	fake.respond("pane close", () => ok({ result: { type: "ok" } }));

	await reapOrphanAgentPanes({
		cli: fake.cli,
		ledgerDir: dir,
		currentSessionId: "live-sess",
		isPidAlive: (pid) => pid !== 999001,
	});

	assert.deepEqual(paneGets(fake.execCalls), ["w4:p9", "w4:p9"]);
	assert.deepEqual(closedPanes(fake.execCalls), ["w4:p9"]);
	assert.equal(leftover(dir, "dead-sess").length, 0);
});

test("dead-PID + keepAlive settled is also reaped — follow-up owner is gone", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-detach-reaper-"));
	seed(dir, "dead-sess", 999002, [
		{ paneId: "w4:p3", agentName: "builder-ab12", closeOnSettle: false },
	]);
	const fake = createFakeCli();
	fake.respond("agent get", () => agentInfo("w4:p3", "builder-ab12", "done"));
	fake.respond("pane close", () => ok({ result: { type: "ok" } }));

	await reapOrphanAgentPanes({
		cli: fake.cli,
		ledgerDir: dir,
		currentSessionId: "live-sess",
		isPidAlive: () => false,
	});

	assert.deepEqual(closedPanes(fake.execCalls), ["w4:p3"]);
	assert.equal(leftover(dir, "dead-sess").length, 0);
});

test("dead-PID + working or blocked leaves the pane and the record", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-detach-reaper-"));
	seed(dir, "dead-sess", 999003, [
		{ paneId: "w4:p1", agentName: "working-agent", closeOnSettle: true, runId: "w" },
		{ paneId: "w4:p2", agentName: "blocked-agent", closeOnSettle: true, runId: "b" },
	]);
	const fake = createFakeCli();
	fake.respond("agent get", (args) => {
		if (args.includes("w4:p1")) return agentInfo("w4:p1", "working-agent", "working");
		return agentInfo("w4:p2", "blocked-agent", "blocked");
	});

	await reapOrphanAgentPanes({
		cli: fake.cli,
		ledgerDir: dir,
		currentSessionId: "live-sess",
		isPidAlive: () => false,
	});

	assert.equal(closedPanes(fake.execCalls).length, 0);
	assert.equal(leftover(dir, "dead-sess").length, 2);
});

test("alive-PID records are never reaped even when the agent is settled", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-detach-reaper-"));
	seed(dir, "other-live", 777, [
		{ paneId: "w2:p4", agentName: "other-advisor-agent", closeOnSettle: true },
	]);
	const fake = createFakeCli();
	fake.respond("agent get", () => agentInfo("w2:p4", "other-advisor-agent", "idle"));

	await reapOrphanAgentPanes({
		cli: fake.cli,
		ledgerDir: dir,
		currentSessionId: "live-sess",
		isPidAlive: (pid) => pid === 777,
	});

	assert.equal(closedPanes(fake.execCalls).length, 0);
	assert.equal(paneGets(fake.execCalls).length, 0);
	assert.equal(leftover(dir, "other-live").length, 1);
});

test("a missing pane or agent drops the record without a close", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-detach-reaper-"));
	seed(dir, "dead-sess", 999004, [{ paneId: "w4:pGone", agentName: "ghost-agent" }]);
	const fake = createFakeCli();
	fake.respond("agent get", () => failed("not_found", "agent not found"));

	await reapOrphanAgentPanes({
		cli: fake.cli,
		ledgerDir: dir,
		currentSessionId: "live-sess",
		isPidAlive: () => false,
	});

	assert.deepEqual(paneGets(fake.execCalls), ["w4:pGone"]);
	assert.equal(closedPanes(fake.execCalls).length, 0);
	assert.equal(leftover(dir, "dead-sess").length, 0);
});

test("concurrent sessions are isolated — own file is not foreign-reaped", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-detach-reaper-"));
	seed(dir, "live-sess", 111, [
		{ paneId: "w1:pOwn", agentName: "own-keep", closeOnSettle: false },
	]);
	seed(dir, "dead-sess", 999005, [
		{ paneId: "w4:pX", agentName: "orphan-idle", closeOnSettle: true },
	]);
	const fake = createFakeCli();
	fake.respond("agent get", (args) => {
		if (args.includes("w1:pOwn")) return agentInfo("w1:pOwn", "own-keep", "idle");
		return agentInfo("w4:pX", "orphan-idle", "idle");
	});
	fake.respond("pane close", () => ok({ result: { type: "ok" } }));

	await reapOrphanAgentPanes({
		cli: fake.cli,
		ledgerDir: dir,
		currentSessionId: "live-sess",
		isPidAlive: (pid) => pid === 111,
	});

	assert.deepEqual(closedPanes(fake.execCalls), ["w4:pX"]);
	assert.equal(leftover(dir, "live-sess").length, 1);
	assert.equal(leftover(dir, "dead-sess").length, 0);
});

test("own leftover closeOnSettle records are finished after a same-process reload", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-detach-reaper-"));
	seed(dir, "live-sess", 111, [
		{ paneId: "w4:pReload", agentName: "e2e-verifier-zz", closeOnSettle: true },
	]);
	const fake = createFakeCli();
	fake.respond("agent get", () => agentInfo("w4:pReload", "e2e-verifier-zz", "done"));
	fake.respond("pane close", () => ok({ result: { type: "ok" } }));

	await reapOrphanAgentPanes({
		cli: fake.cli,
		ledgerDir: dir,
		currentSessionId: "live-sess",
		isPidAlive: () => true,
	});

	assert.deepEqual(closedPanes(fake.execCalls), ["w4:pReload"]);
	assert.equal(leftover(dir, "live-sess").length, 0);
});

test("a pane that is not in any ledger is never closed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-detach-reaper-"));
	const fake = createFakeCli();
	fake.respond("agent get", () => agentInfo("w9:p9", "stranger", "idle"));
	fake.respond("pane close", () => ok({ result: { type: "ok" } }));

	await reapOrphanAgentPanes({
		cli: fake.cli,
		ledgerDir: dir,
		currentSessionId: "live-sess",
		isPidAlive: () => false,
	});

	assert.equal(fake.execCalls.length, 0);
});

test("unknown status is left untouched", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-detach-reaper-"));
	seed(dir, "dead-sess", 999010, [{ paneId: "w4:pU", agentName: "mystery" }]);
	const fake = createFakeCli();
	fake.respond("agent get", () => agentInfo("w4:pU", "mystery", "unknown"));

	await reapOrphanAgentPanes({
		cli: fake.cli,
		ledgerDir: dir,
		currentSessionId: "live-sess",
		isPidAlive: () => false,
	});

	assert.equal(closedPanes(fake.execCalls).length, 0);
	assert.equal(leftover(dir, "dead-sess").length, 1);
});

test("transient agent-get failure preserves the record", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-detach-reaper-"));
	seed(dir, "dead-sess", 999011, [{ paneId: "w4:pT", agentName: "timeout-agent" }]);
	const fake = createFakeCli();
	fake.respond("agent get", () => failed("timeout", "herdr server unavailable"));

	await reapOrphanAgentPanes({
		cli: fake.cli,
		ledgerDir: dir,
		currentSessionId: "live-sess",
		isPidAlive: () => false,
	});

	assert.equal(closedPanes(fake.execCalls).length, 0);
	assert.equal(leftover(dir, "dead-sess").length, 1);
});

test("agent-get exception preserves the record", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-detach-reaper-"));
	seed(dir, "dead-sess", 999012, [{ paneId: "w4:pE", agentName: "throw-agent" }]);
	const fake = createFakeCli();
	fake.respond("agent get", () => {
		throw new Error("ECONNREFUSED");
	});

	await reapOrphanAgentPanes({
		cli: fake.cli,
		ledgerDir: dir,
		currentSessionId: "live-sess",
		isPidAlive: () => false,
	});

	assert.equal(closedPanes(fake.execCalls).length, 0);
	assert.equal(leftover(dir, "dead-sess").length, 1);
});

test("name-reuse / pane-mismatch is not closed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-detach-reaper-"));
	seed(dir, "dead-sess", 999013, [{ paneId: "w4:p1", agentName: "n" }]);
	const fake = createFakeCli();
	fake.respond("agent get", (args) => {
		const target = args[2];
		if (target === "n") return agentInfo("w4:p2", "n", "idle");
		return agentInfo("w4:p1", "replacement", "working");
	});
	fake.respond("pane close", () => ok({ result: { type: "ok" } }));

	await reapOrphanAgentPanes({
		cli: fake.cli,
		ledgerDir: dir,
		currentSessionId: "live-sess",
		isPidAlive: () => false,
	});

	assert.deepEqual(paneGets(fake.execCalls), ["w4:p1"]);
	assert.ok(!paneGets(fake.execCalls).includes("n"));
	assert.equal(closedPanes(fake.execCalls).length, 0);
	assert.equal(leftover(dir, "dead-sess").length, 1);
});

test("close-failure retains the record", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-detach-reaper-"));
	seed(dir, "dead-sess", 999014, [{ paneId: "w4:pC", agentName: "closer" }]);
	const fake = createFakeCli();
	fake.respond("agent get", () => agentInfo("w4:pC", "closer", "idle"));
	fake.respond("pane close", () => failed("unavailable", "socket reset"));

	await reapOrphanAgentPanes({
		cli: fake.cli,
		ledgerDir: dir,
		currentSessionId: "live-sess",
		isPidAlive: () => false,
	});

	assert.deepEqual(closedPanes(fake.execCalls), ["w4:pC"]);
	assert.equal(leftover(dir, "dead-sess").length, 1);
});

test("valid-but-malformed ledger records are skipped", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-detach-reaper-"));
	const path = ledgerFilePath(dir, "dead-sess");
	writeFileSync(
		path,
		`${JSON.stringify({
			sessionId: "dead-sess",
			ownerPid: 999015,
			records: [
				{ paneId: "w4:pBad", agentName: "coerced" },
				{ paneId: 12, agentName: "typed-wrong", runId: "r", label: "x", closeOnSettle: true, ownerPid: 1, createdAt: 1 },
			],
		})}\n`,
	);
	const fake = createFakeCli();
	fake.respond("agent get", () => agentInfo("w4:pBad", "coerced", "idle"));
	fake.respond("pane close", () => ok({ result: { type: "ok" } }));

	await reapOrphanAgentPanes({
		cli: fake.cli,
		ledgerDir: dir,
		currentSessionId: "live-sess",
		isPidAlive: () => false,
	});

	assert.equal(fake.execCalls.length, 0);
	assert.ok(existsSync(path));
	assert.match(readFileSync(path, "utf8"), /w4:pBad/);
});

test("truncated JSON ledger files are skipped", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-detach-reaper-"));
	const path = ledgerFilePath(dir, "dead-sess");
	writeFileSync(path, `{"sessionId":"dead-sess","records":[`);
	const fake = createFakeCli();
	fake.respond("pane close", () => ok({ result: { type: "ok" } }));

	await reapOrphanAgentPanes({
		cli: fake.cli,
		ledgerDir: dir,
		currentSessionId: "live-sess",
		isPidAlive: () => false,
	});

	assert.equal(fake.execCalls.length, 0);
	assert.ok(existsSync(path));
});

test("EPERM is treated as alive", () => {
	const original = process.kill;
	process.kill = ((pid: number) => {
		assert.equal(pid, 4242);
		const error = new Error("operation not permitted") as NodeJS.ErrnoException;
		error.code = "EPERM";
		throw error;
	}) as typeof process.kill;
	try {
		assert.equal(isProcessAlive(4242), true);
	} finally {
		process.kill = original;
	}
});

test("rebindSession preserves destination records including empty-fallback", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-detach-rebind-"));
	const dest = createSessionLedger({ ledgerDir: dir, sessionId: "real-sess", ownerPid: 5 });
	dest.track({
		paneId: "w1:pKeep",
		agentName: "kept",
		runId: "run-keep",
		label: "kept",
		closeOnSettle: true,
	});
	writeFileSync(
		ledgerFilePath(dir, "pid-9"),
		`${JSON.stringify({ sessionId: "pid-9", ownerPid: 5, records: [] }, null, "\t")}\n`,
	);
	const fallback = createSessionLedger({ ledgerDir: dir, sessionId: "pid-9", ownerPid: 5 });
	fallback.rebindSession("real-sess");
	const records = fallback.read().records;
	assert.equal(fallback.sessionId, "real-sess");
	assert.equal(records.length, 1);
	assert.equal(records[0]?.paneId, "w1:pKeep");
	assert.ok(!existsSync(ledgerFilePath(dir, "pid-9")));
});

test("activation rejection is swallowed with a note", async () => {
	const notes: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => {
		notes.push(args.map(String).join(" "));
	};
	try {
		const reap = createSafeReap(async () => {
			throw new Error("rename failed");
		});
		await reap();
		assert.match(notes.join("\n"), /orphan reap failed: rename failed/);
	} finally {
		console.error = original;
	}
});

test("seq-changed abort before close", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-detach-reaper-"));
	seed(dir, "dead-sess", 999016, [{ paneId: "w4:pS", agentName: "seq-agent" }]);
	const fake = createFakeCli();
	let gets = 0;
	fake.respond("agent get", () => {
		gets += 1;
		return agentInfo("w4:pS", "seq-agent", "idle", gets === 1 ? 1 : 2);
	});
	fake.respond("pane close", () => ok({ result: { type: "ok" } }));

	await reapOrphanAgentPanes({
		cli: fake.cli,
		ledgerDir: dir,
		currentSessionId: "live-sess",
		isPidAlive: () => false,
	});

	assert.equal(gets, 2);
	assert.equal(closedPanes(fake.execCalls).length, 0);
	assert.equal(leftover(dir, "dead-sess").length, 1);
});

test("missing state_change_seq keeps the record and does not close", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-detach-reaper-"));
	seed(dir, "dead-sess", 999019, [{ paneId: "w4:pQ", agentName: "seq-missing" }]);
	const fake = createFakeCli();
	fake.respond("agent get", () =>
		ok({
			result: {
				agent: { pane_id: "w4:pQ", name: "seq-missing", agent_status: "idle" },
				type: "agent_info",
			},
		}),
	);
	fake.respond("pane close", () => ok({ result: { type: "ok" } }));

	await reapOrphanAgentPanes({
		cli: fake.cli,
		ledgerDir: dir,
		currentSessionId: "live-sess",
		isPidAlive: () => false,
	});

	assert.deepEqual(paneGets(fake.execCalls), ["w4:pQ", "w4:pQ"]);
	assert.equal(closedPanes(fake.execCalls).length, 0);
	assert.equal(leftover(dir, "dead-sess").length, 1);
});

test("under-age record is left untouched", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-detach-reaper-"));
	seed(dir, "dead-sess", 999017, [
		{ paneId: "w4:pYoung", agentName: "young-agent", createdAt: 90_000 },
	]);
	const fake = createFakeCli();
	fake.respond("agent get", () => agentInfo("w4:pYoung", "young-agent", "idle"));
	fake.respond("pane close", () => ok({ result: { type: "ok" } }));

	await reapOrphanAgentPanes({
		cli: fake.cli,
		ledgerDir: dir,
		currentSessionId: "live-sess",
		isPidAlive: () => false,
		now: () => 90_000 + MIN_RECORD_AGE_MS - 1,
	});

	assert.equal(fake.execCalls.length, 0);
	assert.equal(leftover(dir, "dead-sess").length, 1);
});

test("a transient confirm agent-get failure preserves the record", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-detach-reaper-"));
	seed(dir, "dead-sess", 999018, [{ paneId: "w4:pConfirm", agentName: "confirm-agent" }]);
	const fake = createFakeCli();
	let gets = 0;
	fake.respond("agent get", () => {
		gets += 1;
		return gets === 1
			? agentInfo("w4:pConfirm", "confirm-agent", "idle", 4)
			: failed("timeout", "herdr server unavailable");
	});
	fake.respond("pane close", () => ok({ result: { type: "ok" } }));

	await reapOrphanAgentPanes({
		cli: fake.cli,
		ledgerDir: dir,
		currentSessionId: "live-sess",
		isPidAlive: () => false,
	});

	assert.equal(gets, 2);
	assert.equal(closedPanes(fake.execCalls).length, 0);
	assert.equal(leftover(dir, "dead-sess").length, 1);
});

test("rebindSession merges both ledgers without duplicate pane records", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-detach-rebind-"));
	const destination = createSessionLedger({ ledgerDir: dir, sessionId: "real-sess", ownerPid: 5 });
	destination.track({
		paneId: "w1:pDest",
		agentName: "destination",
		runId: "run-dest",
		label: "destination",
		closeOnSettle: true,
	});
	destination.track({
		paneId: "w1:pShared",
		agentName: "destination-wins",
		runId: "run-dest-shared",
		label: "destination shared",
		closeOnSettle: true,
	});
	const fallback = createSessionLedger({ ledgerDir: dir, sessionId: "pid-9", ownerPid: 5 });
	fallback.track({
		paneId: "w1:pFallback",
		agentName: "fallback",
		runId: "run-fallback",
		label: "fallback",
		closeOnSettle: false,
	});
	fallback.track({
		paneId: "w1:pShared",
		agentName: "fallback-loses",
		runId: "run-fallback-shared",
		label: "fallback shared",
		closeOnSettle: false,
	});

	fallback.rebindSession("real-sess");
	const records = fallback.read().records;
	assert.deepEqual(
		records.map((record) => record.paneId).sort(),
		["w1:pDest", "w1:pFallback", "w1:pShared"],
	);
	assert.equal(records.find((record) => record.paneId === "w1:pShared")?.agentName, "destination-wins");
});

test("concurrent safe-reap requests share one in-flight sweep", async () => {
	let runs = 0;
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const reap = createSafeReap(() => {
		runs += 1;
		return gate;
	});

	const first = reap();
	const second = reap();
	assert.strictEqual(second, first);
	assert.equal(runs, 1);
	release?.();
	await Promise.all([first, second]);
	await reap();
	assert.equal(runs, 2);
});
