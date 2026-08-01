/**
 * @file registry.ts — owns the lifecycle of every spawned run.
 *
 * Processes are spawned into their own process group (`detached: true`) so a
 * kill reaches the whole tree — a dev server's child workers die with it.
 * Output is streamed to a log file on disk and mirrored into a bounded
 * in-memory tail so notifications never have to read the file back.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RunRecord, RunSummary, StartOptions, StartResult } from "./types.ts";

const TAIL_LINES = 500;

const RUNS_DIR = join(homedir(), ".pi", "detach", "runs");

interface LiveRun {
	record: RunRecord;
	child: ChildProcess;
	stream: WriteStream;
	tail: string[];
	pending: string;
	completion: Promise<RunRecord>;
	resolve: (record: RunRecord) => void;
	/** Fires when a watch run emits a line matching its error pattern. */
	onErrorLine?: (record: RunRecord, line: string) => void;
}

export interface Registry {
	start(options: StartOptions): StartResult;
	get(id: string): RunRecord | undefined;
	list(): RunSummary[];
	tail(id: string, lines: number): string;
	readLog(id: string, options: { lines: number; grep?: string }): Promise<string>;
	stop(id: string): RunRecord | undefined;
	stopAll(): void;
	markPromoted(id: string): void;
	onExit(handler: (record: RunRecord) => void): void;
	onErrorLine(handler: (record: RunRecord, line: string) => void): void;
}

function dedupeKey(cwd: string, command: string): string {
	return `${cwd}\u0000${command}`;
}

function shortId(): string {
	return Math.random().toString(36).slice(2, 8);
}

function summarize(record: RunRecord): RunSummary {
	return {
		id: record.id,
		kind: record.kind,
		label: record.label,
		command: record.command,
		cwd: record.cwd,
		status: record.status,
		...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
		startedAt: record.startedAt,
		...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
		durationMs: (record.endedAt ?? Date.now()) - record.startedAt,
	};
}

export function createRegistry(): Registry {
	const runs = new Map<string, LiveRun>();
	const active = new Map<string, string>();
	const exitHandlers: ((record: RunRecord) => void)[] = [];
	const errorLineHandlers: ((record: RunRecord, line: string) => void)[] = [];

	function absorb(live: LiveRun, chunk: string): void {
		live.stream.write(chunk);
		live.pending += chunk;
		const parts = live.pending.split("\n");
		live.pending = parts.pop() ?? "";
		for (const line of parts) {
			live.tail.push(line);
			if (live.record.errorPattern) {
				let matched = false;
				try {
					matched = new RegExp(live.record.errorPattern, "i").test(line);
				} catch {
					matched = line.toLowerCase().includes(live.record.errorPattern.toLowerCase());
				}
				if (matched) {
					for (const handler of errorLineHandlers) handler(live.record, line);
				}
			}
		}
		if (live.tail.length > TAIL_LINES) {
			live.tail.splice(0, live.tail.length - TAIL_LINES);
		}
	}

	function start(options: StartOptions): StartResult {
		const key = dedupeKey(options.cwd, options.command);
		const existingId = active.get(key);
		if (existingId) {
			const existing = runs.get(existingId);
			if (existing && existing.record.status === "running") {
				return { record: existing.record, completion: existing.completion, deduped: true };
			}
		}

		const id = shortId();
		const dir = join(RUNS_DIR, id);
		mkdirSync(dir, { recursive: true });
		const logPath = join(dir, "output.log");

		const record: RunRecord = {
			id,
			kind: options.kind,
			command: options.command,
			cwd: options.cwd,
			label: options.label ?? options.command.slice(0, 40),
			status: "running",
			startedAt: Date.now(),
			promoted: options.kind === "watch",
			logPath,
			...(options.errorPattern ? { errorPattern: options.errorPattern } : {}),
		};

		const child = spawn(options.command, {
			cwd: options.cwd,
			shell: true,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PI_DETACH_RUN_ID: id },
		});
		record.pid = child.pid;

		let resolve!: (value: RunRecord) => void;
		const completion = new Promise<RunRecord>((r) => {
			resolve = r;
		});

		const live: LiveRun = {
			record,
			child,
			stream: createWriteStream(logPath, { flags: "a" }),
			tail: [],
			pending: "",
			completion,
			resolve,
		};

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => absorb(live, chunk));
		child.stderr?.on("data", (chunk: string) => absorb(live, chunk));

		const finish = (code: number | null, termSignal: NodeJS.Signals | null): void => {
			if (record.status !== "running") return;
			if (live.pending) {
				absorb(live, "\n");
			}
			record.status = termSignal ? "killed" : "exited";
			record.exitCode = code ?? undefined;
			record.termSignal = termSignal ?? undefined;
			record.endedAt = Date.now();
			active.delete(key);
			// Announce only once the log file is flushed, so a notified reader
			// calling bg_output immediately cannot see a truncated log.
			live.stream.end(() => {
				resolve(record);
				for (const handler of exitHandlers) handler(record);
			});
		};

		child.on("exit", finish);
		child.on("error", (error) => {
			absorb(live, `\n[detach] spawn failed: ${error.message}\n`);
			finish(127, null);
		});

		runs.set(id, live);
		active.set(key, id);
		return { record, completion, deduped: false };
	}

	function kill(live: LiveRun): void {
		const pid = live.child.pid;
		if (pid === undefined || live.record.status !== "running") return;
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			try {
				live.child.kill("SIGTERM");
			} catch {
				// Process already gone.
			}
		}
	}

	return {
		start,
		get: (id) => runs.get(id)?.record,
		list: () =>
			[...runs.values()].map((live) => summarize(live.record)).sort((a, b) => b.startedAt - a.startedAt),
		tail(id, lines) {
			const live = runs.get(id);
			if (!live) return "";
			return live.tail.slice(-lines).join("\n");
		},
		async readLog(id, { lines, grep }) {
			const live = runs.get(id);
			if (!live) return "";
			let content: string;
			try {
				content = await readFile(live.record.logPath, "utf8");
			} catch {
				content = live.tail.join("\n");
			}
			if (!content) return "";
			let all = content.replace(/\n+$/, "").split("\n");
			if (grep) {
				let test: (line: string) => boolean;
				try {
					const re = new RegExp(grep, "i");
					test = (line) => re.test(line);
				} catch {
					const needle = grep.toLowerCase();
					test = (line) => line.toLowerCase().includes(needle);
				}
				all = all.filter(test);
			}
			return all.slice(-lines).join("\n");
		},
		stop(id) {
			const live = runs.get(id);
			if (!live) return undefined;
			kill(live);
			return live.record;
		},
		stopAll() {
			for (const live of runs.values()) kill(live);
		},
		markPromoted(id) {
			const live = runs.get(id);
			if (live) live.record.promoted = true;
		},
		onExit(handler) {
			exitHandlers.push(handler);
		},
		onErrorLine(handler) {
			errorLineHandlers.push(handler);
		},
	};
}
