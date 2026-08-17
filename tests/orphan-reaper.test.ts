/**
 * @file orphan-reaper.test.ts — session-ledger reaper against the fake herdr CLI.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
import { reapOrphanAgentPanes } from "../src/herdr/reaper.ts";

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

function agentInfo(paneId: string, name: string, agent_status: string): CliResult {
	return ok({ result: { agent: { pane_id: paneId, name, agent_status }, type: "agent_info" } });
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

	assert.ok(
		fake.execCalls.some((args) => args[0] === "pane" && args[1] === "close" && args[2] === "w4:p9"),
	);
	assert.equal(createSessionLedger({ ledgerDir: dir, sessionId: "dead-sess", ownerPid: 1 }).read().records.length, 0);
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

	assert.ok(fake.execCalls.some((args) => args[0] === "pane" && args[1] === "close" && args[2] === "w4:p3"));
	assert.equal(createSessionLedger({ ledgerDir: dir, sessionId: "dead-sess", ownerPid: 1 }).read().records.length, 0);
});

test("dead-PID + working or blocked leaves the pane and the record", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-detach-reaper-"));
	seed(dir, "dead-sess", 999003, [
		{ paneId: "w4:p1", agentName: "working-agent", closeOnSettle: true, runId: "w" },
		{ paneId: "w4:p2", agentName: "blocked-agent", closeOnSettle: true, runId: "b" },
	]);
	const fake = createFakeCli();
	fake.respond("agent get", (args) => {
		if (args.includes("working-agent") || args.includes("w4:p1")) {
			return agentInfo("w4:p1", "working-agent", "working");
		}
		return agentInfo("w4:p2", "blocked-agent", "blocked");
	});

	await reapOrphanAgentPanes({
		cli: fake.cli,
		ledgerDir: dir,
		currentSessionId: "live-sess",
		isPidAlive: () => false,
	});

	assert.ok(!fake.execCalls.some((args) => args[0] === "pane" && args[1] === "close"));
	const leftover = createSessionLedger({ ledgerDir: dir, sessionId: "dead-sess", ownerPid: 1 }).read();
	assert.equal(leftover.records.length, 2);
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

	assert.ok(!fake.execCalls.some((args) => args[0] === "pane" && args[1] === "close"));
	assert.ok(!fake.execCalls.some((args) => args[0] === "agent" && args[1] === "get"));
	assert.equal(
		createSessionLedger({ ledgerDir: dir, sessionId: "other-live", ownerPid: 777 }).read().records.length,
		1,
	);
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

	assert.ok(!fake.execCalls.some((args) => args[0] === "pane" && args[1] === "close"));
	assert.equal(createSessionLedger({ ledgerDir: dir, sessionId: "dead-sess", ownerPid: 1 }).read().records.length, 0);
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
		if (args.includes("own-keep") || args.includes("w1:pOwn")) {
			return agentInfo("w1:pOwn", "own-keep", "idle");
		}
		return agentInfo("w4:pX", "orphan-idle", "idle");
	});
	fake.respond("pane close", () => ok({ result: { type: "ok" } }));

	await reapOrphanAgentPanes({
		cli: fake.cli,
		ledgerDir: dir,
		currentSessionId: "live-sess",
		isPidAlive: (pid) => pid === 111,
	});

	assert.ok(fake.execCalls.some((args) => args[0] === "pane" && args[1] === "close" && args[2] === "w4:pX"));
	assert.ok(!fake.execCalls.some((args) => args[0] === "pane" && args[1] === "close" && args[2] === "w1:pOwn"));
	assert.equal(createSessionLedger({ ledgerDir: dir, sessionId: "live-sess", ownerPid: 111 }).read().records.length, 1);
	assert.equal(createSessionLedger({ ledgerDir: dir, sessionId: "dead-sess", ownerPid: 1 }).read().records.length, 0);
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

	assert.ok(
		fake.execCalls.some((args) => args[0] === "pane" && args[1] === "close" && args[2] === "w4:pReload"),
	);
	assert.equal(createSessionLedger({ ledgerDir: dir, sessionId: "live-sess", ownerPid: 111 }).read().records.length, 0);
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
