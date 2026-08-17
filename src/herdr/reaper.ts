/**
 * @file reaper.ts — close orphaned bg_agent panes left by dead or reloaded Pi sessions.
 *
 * Cross-session pass: scan every ledger file except the current session. A
 * record is eligible only when its owner PID is gone (`process.kill(pid, 0)`
 * / EPERM-means-alive). Settled agents (`idle`/`done`) are closed — including
 * keepAlive panes, because the follow-up owner is gone. `working`/`blocked`/
 * `unknown` panes stay; a human may be watching. Missing agents just drop the
 * record. Empty dead-session files are deleted.
 *
 * Own-session pass: after `/reload` the PID is still alive and closeOnSettle
 * waiters are gone. The live driver finishes leftover closeOnSettle records
 * that have already settled. keepAlive records in a live session are left
 * alone. Panes that never appeared in a ledger are never touched.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { findString, type HerdrCli } from "./cli.ts";
import {
	type AgentPaneLedgerRecord,
	ledgerFilePath,
	persistLedgerFile,
	readLedgerFile,
} from "./ledger.ts";

export interface ReaperDeps {
	cli: HerdrCli;
	ledgerDir: string;
	currentSessionId: string;
	isPidAlive: (pid: number) => boolean;
}

const SETTLED = new Set(["idle", "done"]);
const LEAVE = new Set(["working", "blocked", "unknown"]);

export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// Alive but not owned by us — still another live session.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function agentStatus(json: unknown): string | undefined {
	const raw = findString(json, "agent_status") ?? findString(json, "status");
	return raw?.toLowerCase();
}

async function lookupAgent(
	cli: HerdrCli,
	record: AgentPaneLedgerRecord,
): Promise<"missing" | "settled" | "leave"> {
	const targets = [record.agentName, record.paneId].filter((target, index, all) => {
		return target.length > 0 && all.indexOf(target) === index;
	});
	for (const target of targets) {
		const got = await cli.exec(["agent", "get", target]);
		if (!got.ok) continue;
		const status = agentStatus(got.json);
		if (status && SETTLED.has(status)) return "settled";
		if (status && LEAVE.has(status)) return "leave";
		// Present but unclassified — do not close.
		return "leave";
	}
	return "missing";
}

async function decideRecord(
	cli: HerdrCli,
	record: AgentPaneLedgerRecord,
	mode: "foreign-dead" | "own-close-on-settle",
): Promise<"keep" | "drop"> {
	const state = await lookupAgent(cli, record);
	if (state === "missing") return "drop";
	if (state === "leave") return "keep";
	if (mode === "own-close-on-settle" && !record.closeOnSettle) return "keep";
	await cli.exec(["pane", "close", record.paneId]);
	return "drop";
}

/**
 * Reap settled agent panes whose owning Pi process is dead, and finish this
 * session's leftover closeOnSettle records after a same-process reload.
 */
export async function reapOrphanAgentPanes(deps: ReaperDeps): Promise<void> {
	const { cli, ledgerDir, currentSessionId, isPidAlive } = deps;
	let names: string[];
	try {
		names = readdirSync(ledgerDir);
	} catch {
		return;
	}

	const ownPath = ledgerFilePath(ledgerDir, currentSessionId);

	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const path = join(ledgerDir, name);
		const file = readLedgerFile(path);
		if (!file) continue;

		const isOwn = path === ownPath || file.sessionId === currentSessionId;
		const next: AgentPaneLedgerRecord[] = [];
		for (const record of file.records) {
			if (isOwn) {
				if ((await decideRecord(cli, record, "own-close-on-settle")) === "keep") {
					next.push(record);
				}
				continue;
			}
			if (isPidAlive(record.ownerPid)) {
				next.push(record);
				continue;
			}
			if ((await decideRecord(cli, record, "foreign-dead")) === "keep") {
				next.push(record);
			}
		}

		const unchanged =
			next.length === file.records.length && next.every((record, index) => record === file.records[index]);
		if (unchanged) continue;
		file.records = next;
		persistLedgerFile(path, file);
	}
}
