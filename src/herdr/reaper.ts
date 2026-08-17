/**
 * @file reaper.ts — close orphaned bg_agent panes left by dead or reloaded Pi sessions.
 *
 * Cross-session pass: scan every ledger file except the current session. A
 * record is eligible only when its owner PID is gone (`process.kill(pid, 0)`
 * / EPERM-means-alive) and it is older than MIN_RECORD_AGE_MS. Status is
 * resolved solely by `agent get <paneId>` — never by agent name, because
 * Herdr reuses names. Occupant pane_id + name must match the ledger or the
 * record is kept. Settled agents (`idle`/`done`) are closed after a second
 * get confirms pane, name, settled state, and `state_change_seq` are
 * unchanged. `working`/`blocked`/`unknown` panes stay. `not_found` drops
 * the record without closing; any other CLI error keeps it. Empty
 * dead-session files are deleted.
 *
 * Own-session pass: after `/reload` the PID is still alive and closeOnSettle
 * waiters are gone. The live driver finishes leftover closeOnSettle records
 * that have already settled. keepAlive records in a live session are left
 * alone. Panes that never appeared in a ledger are never touched.
 *
 * Herdr has no server-side conditional close. The confirm-get plus minimum
 * age shrinks the check-to-close race; a sub-ms residual window remains
 * for settled orphans of dead sessions until upstream adds one.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { findNumber, findString, type CliResult, type HerdrCli } from "./cli.ts";
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
	now?: () => number;
	minRecordAgeMs?: number;
}

const SETTLED = new Set(["idle", "done"]);
const LEAVE = new Set(["working", "blocked", "unknown"]);

/** Records younger than this are never closed — PID-reuse / occupant-swap cushion. */
export const MIN_RECORD_AGE_MS = 60_000;

interface Occupant {
	paneId: string;
	agentName: string;
	status: string;
	stateChangeSeq: number | undefined;
}

type Lookup =
	| { kind: "not_found" }
	| { kind: "error" }
	| { kind: "mismatch" }
	| { kind: "match"; occupant: Occupant };

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

function occupantFrom(json: unknown): Occupant | undefined {
	const paneId = findString(json, "pane_id");
	const agentName = findString(json, "name") ?? findString(json, "agent_name");
	if (!paneId || !agentName) return undefined;
	return {
		paneId,
		agentName,
		status: agentStatus(json) ?? "unknown",
		stateChangeSeq: findNumber(json, "state_change_seq"),
	};
}

async function lookupByPane(cli: HerdrCli, record: AgentPaneLedgerRecord): Promise<Lookup> {
	let got: CliResult;
	try {
		got = await cli.exec(["agent", "get", record.paneId]);
	} catch {
		return { kind: "error" };
	}
	if (!got.ok) {
		return got.errorCode === "not_found" ? { kind: "not_found" } : { kind: "error" };
	}
	const occupant = occupantFrom(got.json);
	if (!occupant || occupant.paneId !== record.paneId || occupant.agentName !== record.agentName) {
		return { kind: "mismatch" };
	}
	return { kind: "match", occupant };
}

function sameSettledOccupant(first: Occupant, second: Occupant): boolean {
	return (
		second.paneId === first.paneId &&
		second.agentName === first.agentName &&
		SETTLED.has(second.status) &&
		second.status === first.status &&
		second.stateChangeSeq === first.stateChangeSeq
	);
}

async function confirmAndClose(
	cli: HerdrCli,
	record: AgentPaneLedgerRecord,
	first: Occupant,
): Promise<"keep" | "drop"> {
	const again = await lookupByPane(cli, record);
	if (again.kind === "not_found") return "drop";
	if (again.kind !== "match" || !sameSettledOccupant(first, again.occupant)) return "keep";
	let closed: CliResult;
	try {
		closed = await cli.exec(["pane", "close", record.paneId]);
	} catch {
		return "keep";
	}
	if (closed.ok || closed.errorCode === "not_found") return "drop";
	return "keep";
}

async function decideRecord(
	cli: HerdrCli,
	record: AgentPaneLedgerRecord,
	mode: "foreign-dead" | "own-close-on-settle",
): Promise<"keep" | "drop"> {
	const looked = await lookupByPane(cli, record);
	if (looked.kind === "not_found") return "drop";
	if (looked.kind !== "match") return "keep";
	if (LEAVE.has(looked.occupant.status) || !SETTLED.has(looked.occupant.status)) return "keep";
	if (mode === "own-close-on-settle" && !record.closeOnSettle) return "keep";
	return confirmAndClose(cli, record, looked.occupant);
}

/**
 * Deduped wrapper so concurrent activation/launch sweeps share one pass.
 * Failures are noted and swallowed — fire-and-forget call sites never reject.
 */
export function createSafeReap(run: () => Promise<void>): () => Promise<void> {
	let inflight: Promise<void> | undefined;
	return () => {
		if (inflight) return inflight;
		inflight = (async () => {
			try {
				await run();
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				console.error(`[pi-detach] orphan reap failed: ${detail}`);
			} finally {
				inflight = undefined;
			}
		})();
		return inflight;
	};
}

function isOldEnough(record: AgentPaneLedgerRecord, now: number, minAgeMs: number): boolean {
	return now - record.createdAt >= minAgeMs;
}

/**
 * Reap settled agent panes whose owning Pi process is dead, and finish this
 * session's leftover closeOnSettle records after a same-process reload.
 */
export async function reapOrphanAgentPanes(deps: ReaperDeps): Promise<void> {
	const { cli, ledgerDir, currentSessionId, isPidAlive } = deps;
	const now = deps.now ?? Date.now;
	const minAgeMs = deps.minRecordAgeMs ?? MIN_RECORD_AGE_MS;
	let names: string[];
	try {
		names = readdirSync(ledgerDir);
	} catch {
		return;
	}

	const ownPath = ledgerFilePath(ledgerDir, currentSessionId);
	const clock = now();

	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const path = join(ledgerDir, name);
		const file = readLedgerFile(path);
		if (!file) continue;

		const isOwn = path === ownPath || file.sessionId === currentSessionId;
		const next: AgentPaneLedgerRecord[] = [];
		for (const record of file.records) {
			if (isOwn) {
				if (!record.closeOnSettle || !isOldEnough(record, clock, minAgeMs)) {
					next.push(record);
					continue;
				}
				if ((await decideRecord(cli, record, "own-close-on-settle")) === "keep") {
					next.push(record);
				}
				continue;
			}
			if (isPidAlive(record.ownerPid) || !isOldEnough(record, clock, minAgeMs)) {
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
