/**
 * @file registry.ts — owns the lifecycle of every run, regardless of backend.
 *
 * The registry keeps records, dedupe, logs, tails, and exit/error handlers;
 * where the process actually lives is a driver's concern. bg_run commands are
 * always local, invisible processes — a viewer pane is attached only if one
 * is promoted to the background (see onPromoted). Watches and agents are
 * hosted in visible herdr panes from birth when the herdr driver is present,
 * with watch starts degrading to the local driver if herdr refuses.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	DriverHandle,
	DriverOutcome,
	DriverStart,
	RunController,
	RunRecord,
	RunSummary,
	StartOptions,
	StartResult,
} from "./types.ts";

const TAIL_LINES = 500;

const RUNS_DIR = join(homedir(), ".pi", "detach", "runs");

interface LiveRun {
	record: RunRecord;
	handle: DriverHandle;
	stream: WriteStream;
	tail: string[];
	pending: string;
	doneMatched?: boolean;
	completion: Promise<RunRecord>;
	resolve: (record: RunRecord) => void;
}

export interface Registry {
	start(options: StartOptions): Promise<StartResult>;
	get(id: string): RunRecord | undefined;
	list(): RunSummary[];
	tail(id: string, lines: number): string;
	readLog(id: string, options: { lines: number; grep?: string }): Promise<string>;
	stop(id: string): RunRecord | undefined;
	/** "shutdown" leaves herdr panes running — they are visible and user-owned. */
	stopAll(mode?: "stop" | "shutdown"): void;
	markPromoted(id: string): void;
	onExit(handler: (record: RunRecord) => void): void;
	onErrorLine(handler: (record: RunRecord, line: string) => void): void;
	onDoneLine(handler: (record: RunRecord, line: string) => void): void;
	onProgress(handler: (record: RunRecord, note: string) => void): void;
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
		backend: record.backend,
		label: record.label,
		command: record.command,
		cwd: record.cwd,
		status: record.status,
		...(record.paneId !== undefined ? { paneId: record.paneId } : {}),
		...(record.agentName !== undefined ? { agentName: record.agentName } : {}),
		...(record.agentState !== undefined ? { agentState: record.agentState } : {}),
		...(record.resultPath !== undefined ? { resultPath: record.resultPath } : {}),
		...(record.resultStatus !== undefined ? { resultStatus: record.resultStatus } : {}),
		...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
		startedAt: record.startedAt,
		...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
		durationMs: (record.endedAt ?? Date.now()) - record.startedAt,
	};
}

function grepLines(all: string[], grep: string | undefined): string[] {
	if (!grep) return all;
	let test: (line: string) => boolean;
	try {
		const re = new RegExp(grep, "i");
		test = (line) => re.test(line);
	} catch {
		const needle = grep.toLowerCase();
		test = (line) => line.toLowerCase().includes(needle);
	}
	return all.filter(test);
}

/** The built-in driver: a detached local process group with streamed output. */
const localDriver: DriverStart = (options, controller) => {
	const { record } = controller;
	const child: ChildProcess = spawn(options.command, {
		cwd: options.cwd,
		shell: true,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, PI_DETACH_RUN_ID: record.id },
	});
	record.pid = child.pid;

	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => controller.emitOutput(chunk));
	child.stderr?.on("data", (chunk: string) => controller.emitOutput(chunk));

	const finish = (code: number | null, termSignal: NodeJS.Signals | null): void => {
		controller.finish({
			exitCode: code ?? undefined,
			termSignal: termSignal ?? undefined,
			killed: termSignal !== null,
		});
	};
	child.on("exit", finish);
	child.on("error", (error) => {
		controller.emitOutput(`\n[detach] spawn failed: ${error.message}\n`);
		finish(127, null);
	});

	const kill = (): void => {
		const pid = child.pid;
		if (pid === undefined || record.status !== "running") return;
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			try {
				child.kill("SIGTERM");
			} catch {
				// Process already gone.
			}
		}
	};

	return Promise.resolve({ pid: child.pid, stop: kill });
};

export interface RegistryOptions {
	/** Hosts watch and agent runs in herdr panes. bg_run never uses it. */
	herdrDriver?: DriverStart;
	/** Called when a local run is promoted to the background — attaches a viewer pane. */
	onPromoted?: (record: RunRecord, completion: Promise<RunRecord>) => void;
}

function matchesPattern(pattern: string, line: string): boolean {
	try {
		return new RegExp(pattern, "i").test(line);
	} catch {
		return line.toLowerCase().includes(pattern.toLowerCase());
	}
}

export function createRegistry(options: RegistryOptions = {}): Registry {
	const { herdrDriver, onPromoted } = options;
	const runs = new Map<string, LiveRun>();
	const active = new Map<string, string>();
	const exitHandlers: ((record: RunRecord) => void)[] = [];
	const errorLineHandlers: ((record: RunRecord, line: string) => void)[] = [];
	const doneLineHandlers: ((record: RunRecord, line: string) => void)[] = [];
	const progressHandlers: ((record: RunRecord, note: string) => void)[] = [];

	function absorb(live: LiveRun, chunk: string): void {
		live.stream.write(chunk);
		live.pending += chunk;
		const parts = live.pending.split("\n");
		live.pending = parts.pop() ?? "";
		for (const line of parts) {
			live.tail.push(line);
			if (live.record.status !== "running") continue;
			if (live.record.donePattern && !live.doneMatched && matchesPattern(live.record.donePattern, line)) {
				live.doneMatched = true;
				for (const handler of doneLineHandlers) handler(live.record, line);
				continue;
			}
			if (live.record.errorPattern && matchesPattern(live.record.errorPattern, line)) {
				for (const handler of errorLineHandlers) handler(live.record, line);
			}
		}
		if (live.tail.length > TAIL_LINES) {
			live.tail.splice(0, live.tail.length - TAIL_LINES);
		}
	}

	async function start(options: StartOptions): Promise<StartResult> {
		if (options.kind === "agent" && options.reuseName && !options.requiredArtifactPath) {
			const prior = [...runs.values()]
				.map((live) => live.record)
				.filter((candidate) => candidate.agentName === options.reuseName)
				.sort((a, b) => b.startedAt - a.startedAt)[0];
			if (prior?.resultPath) options = { ...options, requiredArtifactPath: prior.resultPath };
		}
		const key = dedupeKey(options.cwd, options.command);
		if (options.kind !== "agent") {
			const existingId = active.get(key);
			if (existingId) {
				const existing = runs.get(existingId);
				if (existing && existing.record.status === "running") {
					return { record: existing.record, completion: existing.completion, deduped: true };
				}
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
			// bg_run commands are foreground work: always local and invisible,
			// like Claude Code's shell tool. Only watches and agents live in
			// panes from birth.
			backend: options.kind !== "run" && herdrDriver ? "herdr" : "local",
			startedAt: Date.now(),
			// Watches are announced from birth; runs and agents only after their
			// tool call detaches.
			promoted: options.kind === "watch",
			logPath,
			...(options.errorPattern ? { errorPattern: options.errorPattern } : {}),
			...(options.donePattern ? { donePattern: options.donePattern } : {}),
			...(options.requiredArtifactPath ? { resultPath: options.requiredArtifactPath } : {}),
			...(options.kind === "agent" ? { closeOnSettle: Boolean(options.closeOnSettle) } : {}),
			...(options.quiet ? { quiet: true } : {}),
		};

		let resolve!: (value: RunRecord) => void;
		const completion = new Promise<RunRecord>((r) => {
			resolve = r;
		});

		const live: LiveRun = {
			record,
			handle: { stop: () => {} },
			stream: createWriteStream(logPath, { flags: "a" }),
			tail: [],
			pending: "",
			completion,
			resolve,
		};

		const controller: RunController = {
			record,
			emitOutput: (chunk) => absorb(live, chunk),
			progress: (note) => {
				if (record.status !== "running") return;
				absorb(live, `[detach] ${note}\n`);
				for (const handler of progressHandlers) handler(record, note);
			},
			finish: (outcome: DriverOutcome) => {
				if (record.status !== "running") return;
				if (live.pending) absorb(live, "\n");
				if (outcome.note) absorb(live, `[detach] ${outcome.note}\n`);
				record.status = outcome.killed ? "killed" : "exited";
				record.exitCode = outcome.exitCode;
				record.termSignal = outcome.termSignal;
				if (outcome.agentState) record.agentState = outcome.agentState;
				if (outcome.resultStatus) record.resultStatus = outcome.resultStatus;
				record.endedAt = Date.now();
				active.delete(key);
				// Announce only once the log file is flushed, so a notified reader
				// calling bg_output immediately cannot see a truncated log.
				live.stream.end(() => {
					resolve(record);
					for (const handler of exitHandlers) handler(record);
				});
			},
		};

		// Claim the dedupe slot before any async work so a parallel fan-out of
		// the same command converges on one run.
		runs.set(id, live);
		if (options.kind !== "agent") active.set(key, id);

		let handle: DriverHandle;
		try {
			if (options.kind === "run" || !herdrDriver) {
				if (options.kind === "agent") {
					throw new Error("bg_agent requires pi to be running inside a herdr pane");
				}
				handle = await localDriver(options, controller);
			} else {
				handle = await herdrDriver(options, controller);
			}
		} catch (error) {
			if (herdrDriver && options.kind === "watch" && record.status === "running") {
				// Herdr refused (server down, split failed): degrade to the local
				// backend rather than failing the run.
				record.backend = "local";
				record.fallbackReason = error instanceof Error ? error.message : String(error);
				handle = await localDriver(options, controller);
			} else {
				runs.delete(id);
				if (active.get(key) === id) active.delete(key);
				live.stream.end();
				throw error;
			}
		}
		live.handle = handle;
		record.pid = handle.pid ?? record.pid;
		record.paneId = handle.paneId ?? record.paneId;
		record.agentName = handle.agentName ?? record.agentName;

		return { record, completion, deduped: false };
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
			// A running pane-hosted run has no streamed log; read the pane live.
			if (live.record.status === "running" && live.handle.readLive) {
				try {
					const text = await live.handle.readLive(Math.max(lines * 2, 200));
					const all = grepLines(text.replace(/\n+$/, "").split("\n"), grep);
					return all.slice(-lines).join("\n");
				} catch {
					// Fall through to whatever made it into the log.
				}
			}
			let content: string;
			try {
				content = await readFile(live.record.logPath, "utf8");
			} catch {
				content = live.tail.join("\n");
			}
			if (!content) return "";
			const all = grepLines(content.replace(/\n+$/, "").split("\n"), grep);
			return all.slice(-lines).join("\n");
		},
		stop(id) {
			const live = runs.get(id);
			if (!live) return undefined;
			if (live.record.status === "running") live.handle.stop();
			return live.record;
		},
		stopAll(mode = "stop") {
			for (const live of runs.values()) {
				if (live.record.status !== "running") continue;
				if (mode === "shutdown" && live.handle.detach) {
					// Herdr panes are visible and survive pi on purpose.
					live.handle.detach();
				} else {
					live.handle.stop();
				}
			}
		},
		markPromoted(id) {
			const live = runs.get(id);
			if (!live) return;
			live.record.promoted = true;
			// The run just became genuine background work — now it earns a
			// visible surface, unless the caller marked it quiet (silent waiters).
			if (live.record.kind === "run" && live.record.status === "running" && !live.record.quiet) {
				onPromoted?.(live.record, live.completion);
			}
		},
		onExit(handler) {
			exitHandlers.push(handler);
		},
		onErrorLine(handler) {
			errorLineHandlers.push(handler);
		},
		onDoneLine(handler) {
			doneLineHandlers.push(handler);
		},
		onProgress(handler) {
			progressHandlers.push(handler);
		},
	};
}
