/**
 * @file ledger.ts — per-session on-disk ledger of Herdr agent panes this Pi owns.
 *
 * Location: `~/.pi/detach/ledgers/<sessionId>.json` (same state root as run logs).
 * One file per Pi session so parallel advisors never share a write target.
 * Writes are atomic (temp file + rename). The reaper in reaper.ts scans other
 * sessions' files; this module only mutates the current session's file.
 *
 * Session key: `PI_SESSION_ID` when the process has it, otherwise the id from
 * `sessionManager.getSessionId()` after session_start, otherwise `pid-<pid>`.
 *
 * Files and records are strictly validated. Invalid JSON, files, or records
 * are skipped — never coerced — so a malformed occupant cannot be closed.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_LEDGER_DIR = join(homedir(), ".pi", "detach", "ledgers");

export interface AgentPaneLedgerRecord {
	paneId: string;
	agentName: string;
	runId: string;
	label: string;
	/** Inverse of bg_agent keepAlive — false means the pane was reserved for follow-up. */
	closeOnSettle: boolean;
	ownerPid: number;
	createdAt: number;
}

export interface SessionLedgerFile {
	sessionId: string;
	ownerPid: number;
	records: AgentPaneLedgerRecord[];
}

export interface AgentPaneLedger {
	readonly sessionId: string;
	readonly dir: string;
	track(record: Omit<AgentPaneLedgerRecord, "ownerPid" | "createdAt">): void;
	forget(paneId: string): void;
	/** Point this ledger at the real Pi session id once session_start exposes it. */
	rebindSession(sessionId: string): void;
	read(): SessionLedgerFile;
}

export interface SessionLedgerDeps {
	ledgerDir: string;
	sessionId: string;
	ownerPid: number;
}

export function resolveOwningSessionId(
	env: Record<string, string | undefined> = process.env,
	pid: number = process.pid,
): string {
	const fromEnv = env.PI_SESSION_ID?.trim();
	if (fromEnv) return fromEnv;
	return `pid-${pid}`;
}

export function ledgerFilePath(ledgerDir: string, sessionId: string): string {
	const safe = sessionId.replace(/[^A-Za-z0-9._-]+/g, "_");
	return join(ledgerDir, `${safe}.json`);
}

function isPositiveInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Strict record schema — extra keys are ignored, missing/wrong types reject. */
export function parseLedgerRecord(value: unknown): AgentPaneLedgerRecord | undefined {
	if (!isRecord(value)) return undefined;
	if (!isNonEmptyString(value.paneId)) return undefined;
	if (!isNonEmptyString(value.agentName)) return undefined;
	if (typeof value.runId !== "string") return undefined;
	if (typeof value.label !== "string") return undefined;
	if (typeof value.closeOnSettle !== "boolean") return undefined;
	if (!isPositiveInt(value.ownerPid)) return undefined;
	if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) || value.createdAt < 0) {
		return undefined;
	}
	return {
		paneId: value.paneId,
		agentName: value.agentName,
		runId: value.runId,
		label: value.label,
		closeOnSettle: value.closeOnSettle,
		ownerPid: value.ownerPid,
		createdAt: value.createdAt,
	};
}

function parseLedgerFile(value: unknown): SessionLedgerFile | undefined {
	if (!isRecord(value)) return undefined;
	if (!isNonEmptyString(value.sessionId)) return undefined;
	if (!isPositiveInt(value.ownerPid)) return undefined;
	if (!Array.isArray(value.records)) return undefined;
	const records: AgentPaneLedgerRecord[] = [];
	for (const entry of value.records) {
		const parsed = parseLedgerRecord(entry);
		if (parsed) records.push(parsed);
	}
	return { sessionId: value.sessionId, ownerPid: value.ownerPid, records };
}

export function readLedgerFile(path: string): SessionLedgerFile | undefined {
	try {
		return parseLedgerFile(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
}

/** Destination records win on paneId collision so a reload cannot clobber them. */
export function mergeLedgerRecords(
	destination: AgentPaneLedgerRecord[],
	incoming: AgentPaneLedgerRecord[],
): AgentPaneLedgerRecord[] {
	const byPane = new Map(destination.map((record) => [record.paneId, record]));
	for (const record of incoming) {
		if (!byPane.has(record.paneId)) byPane.set(record.paneId, record);
	}
	return [...byPane.values()];
}

/** Atomic replace, or unlink when the session file has no remaining records. */
export function persistLedgerFile(path: string, file: SessionLedgerFile): void {
	if (file.records.length === 0) {
		try {
			unlinkSync(path);
		} catch {
			// Already gone.
		}
		return;
	}
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(file, null, "\t")}\n`, "utf8");
	renameSync(tmp, path);
}

export function createSessionLedger(deps: SessionLedgerDeps): AgentPaneLedger {
	mkdirSync(deps.ledgerDir, { recursive: true });
	let sessionId = deps.sessionId;
	const ownerPid = deps.ownerPid;

	function pathFor(id: string): string {
		return ledgerFilePath(deps.ledgerDir, id);
	}

	function empty(): SessionLedgerFile {
		return { sessionId, ownerPid, records: [] };
	}

	function load(): SessionLedgerFile {
		return readLedgerFile(pathFor(sessionId)) ?? empty();
	}

	function persist(file: SessionLedgerFile): void {
		persistLedgerFile(pathFor(file.sessionId), file);
	}

	return {
		get sessionId() {
			return sessionId;
		},
		dir: deps.ledgerDir,
		track(record) {
			const file = load();
			const next: AgentPaneLedgerRecord = {
				...record,
				ownerPid,
				createdAt: Date.now(),
			};
			// Upsert by pane — reuse of a keepAlive agent replaces the prior run.
			file.records = [...file.records.filter((entry) => entry.paneId !== next.paneId), next];
			file.sessionId = sessionId;
			file.ownerPid = ownerPid;
			persist(file);
		},
		forget(paneId) {
			const file = load();
			file.records = file.records.filter((entry) => entry.paneId !== paneId);
			persist(file);
		},
		rebindSession(nextId) {
			const trimmed = nextId.trim();
			if (!trimmed || trimmed === sessionId) return;
			const oldPath = pathFor(sessionId);
			const destPath = pathFor(trimmed);
			const fallback = load();
			const destination = readLedgerFile(destPath);
			sessionId = trimmed;
			persist({
				sessionId,
				ownerPid,
				records: mergeLedgerRecords(destination?.records ?? [], fallback.records),
			});
			if (oldPath !== destPath) {
				try {
					unlinkSync(oldPath);
				} catch {
					// Previous file may already be empty/unlinked.
				}
			}
		},
		read: load,
	};
}
