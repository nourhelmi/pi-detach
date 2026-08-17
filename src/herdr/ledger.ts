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

export function readLedgerFile(path: string): SessionLedgerFile | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as SessionLedgerFile;
		if (!parsed || typeof parsed.sessionId !== "string" || !Array.isArray(parsed.records)) {
			return undefined;
		}
		return parsed;
	} catch {
		return undefined;
	}
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
			const previous = load();
			const oldPath = pathFor(sessionId);
			sessionId = trimmed;
			previous.sessionId = sessionId;
			previous.ownerPid = ownerPid;
			persist(previous);
			if (oldPath !== pathFor(sessionId)) {
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
