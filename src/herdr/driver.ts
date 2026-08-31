/**
 * @file driver.ts — hosts watches and agents in visible herdr panes.
 *
 * bg_run commands never come through here — they are invisible local
 * processes (a promoted one gets a viewer pane, see viewer.ts). Watches
 * (`bg_watch`) are typed into a pane and completion is detected via the
 * sentinel + a blocking `herdr wait output` child. Ctrl+C in the pane kills
 * the sentinel along with the command, so a slow supervisor poll watches
 * process-info and settles the run as killed when the shell is back at its
 * prompt without a sentinel having matched.
 *
 * Agent runs (`bg_agent`) start a real agent with `herdr agent start`, bind
 * prompt submission to an observed lifecycle transition, then supervise
 * working/done/idle/blocked and report how the turn settled.
 */

import { type CliResult, findString, type HerdrCli, type Waiter } from "./cli.ts";
import { readFile } from "node:fs/promises";

import { type HerdrContext, toastsEnabled } from "./context.ts";
import type { AgentPaneLedger } from "./ledger.ts";
import { isIdleShell, type PaneManager } from "./panes.ts";
import { isSettledOccupantOf, occupantFrom } from "./reaper.ts";
import { exitMatchPattern, extractRunOutput, parseExitCode, wrapRunCommand } from "./sentinel.ts";
import type {
	AgentSettledState,
	DriverHandle,
	DriverStart,
	RunController,
	StartOptions,
} from "../types.ts";

const SUPERVISE_COMMAND_MS = 45_000;
const SUPERVISE_AGENT_MS = 60_000;
const WATCH_POLL_MS = 10_000;
const INTERRUPT_GRACE_MS = 3_000;
const STOP_SETTLE_MS = 1_500;
const COMMAND_WAITER_RETRY_BASE_MS = 250;
const COMMAND_WAITER_RETRY_MAX_MS = 15_000;
const AGENT_START_TIMEOUT_MS = 45_000;
const AGENT_WORKING_TIMEOUT_MS = 20_000;
const AGENT_PROMPT_WAIT_TIMEOUT_MS = 20_000;
const AGENT_PROMPT_PROCESS_TIMEOUT_MS = AGENT_PROMPT_WAIT_TIMEOUT_MS + 5_000;
// herdr 0.8 waits require an explicit --timeout; emulate the old indefinite wait.
const WAIT_FOREVER_MS = 7 * 24 * 60 * 60 * 1000;
const SHELL_READY_ATTEMPTS = 120;
const SHELL_READY_POLL_MS = 250;
const READ_LINES = 400;

export interface HerdrDriverDeps {
	cli: HerdrCli;
	ctx: HerdrContext;
	panes: PaneManager;
	env?: Record<string, string | undefined>;
	/** Current session's agent-pane ledger; omitted in tests that do not cover orphans. */
	ledger?: AgentPaneLedger;
	/** Cheap orphan sweep kicked off before a new agent launch (must not block). */
	reapOrphans?: () => Promise<void>;
}

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(input))) {
		tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
	}
	return tokens;
}

function agentName(label: string, id: string): string {
	const slug =
		label
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^[^a-z]+/, "")
			.replace(/-+$/, "") || "agent";
	return `${slug.slice(0, 31 - id.length)}-${id}`;
}

function isUnavailableShell(result: CliResult): boolean {
	const detail = `${result.errorMessage ?? ""}\n${result.stderr}`.toLowerCase();
	return result.errorCode === "agent_pane_busy" || detail.includes("not an available shell");
}

type ObservedAgentState = "working" | "done" | "idle" | "blocked";

function observedAgentState(json: unknown): ObservedAgentState | undefined {
	const raw = (findString(json, "agent_status") ?? findString(json, "status"))?.toLowerCase();
	return raw === "working" || raw === "done" || raw === "idle" || raw === "blocked"
		? raw
		: undefined;
}

function isSameOccupant(
	occupant: ReturnType<typeof occupantFrom>,
	paneId: string,
	name: string,
): boolean {
	return Boolean(occupant && occupant.paneId === paneId && occupant.agentName === name);
}

function generationChanged(
	before: ReturnType<typeof occupantFrom>,
	after: ReturnType<typeof occupantFrom>,
): boolean {
	return Boolean(
		before
			&& after
			&& typeof before.stateChangeSeq === "number"
			&& typeof after.stateChangeSeq === "number"
			&& before.stateChangeSeq !== after.stateChangeSeq,
	);
}

function isCompactionRunning(output: string): boolean {
	// Only inspect the live tail so an old transcript or a tool result that
	// merely mentions compaction cannot suppress a genuine final settlement.
	const normalized = output.slice(-4_000).toLowerCase();
	const startedAt = Math.max(
		normalized.lastIndexOf("openai compaction running"),
		normalized.lastIndexOf("compacting context"),
	);
	if (startedAt < 0) return false;
	const finishedAt = Math.max(
		normalized.lastIndexOf("openai compaction complete"),
		normalized.lastIndexOf("openai compaction failed"),
		normalized.lastIndexOf("compaction failed:"),
	);
	return startedAt > finishedAt;
}

const REQUIRED_ARTIFACT_HEADINGS = [
	"Status",
	"Claims",
	"Evidence",
	"Files",
	"Decisions",
	"Remaining Risk",
];

export async function settlementArtifactIssue(path: string): Promise<string | undefined> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" ? `missing ${path}` : `could not read ${path}: ${(error as Error).message}`;
	}
	if (!content.trim()) return `empty ${path}`;
	const missing: string[] = [];
	const empty: string[] = [];
	for (const heading of REQUIRED_ARTIFACT_HEADINGS) {
		const match = new RegExp(`^#{1,6}\\s+${heading}\\s*$`, "im").exec(content);
		if (!match) {
			missing.push(heading);
			continue;
		}
		const remainder = content.slice(match.index + match[0].length);
		const nextHeading = remainder.search(/^#{1,6}\s+\S.*$/m);
		const body = (nextHeading >= 0 ? remainder.slice(0, nextHeading) : remainder).trim();
		if (!body) empty.push(heading);
	}
	if (missing.length) return `${path} is missing headings: ${missing.join(", ")}`;
	return empty.length ? `${path} has empty sections: ${empty.join(", ")}` : undefined;
}

export function createHerdrDriver(deps: HerdrDriverDeps): DriverStart {
	const { cli, panes, ledger, reapOrphans } = deps;
	const toasts = toastsEnabled(deps.env ?? process.env);

	// Layout policy lives on the pane manager's caller-split coordinator.
	// This stack is agent-only (not the idle pool); the shared coordinator
	// owns the stack-first split policy and surviving-target view.
	const agentPaneStack: string[] = [];

	// Fan-out launches execute concurrently. Serialize pane allocation so the
	// caller layout state is observed before another launch chooses its base.
	let agentStartQueue = Promise.resolve();

	async function paneAlive(id: string): Promise<boolean> {
		const info = await cli.exec(["pane", "process-info", "--pane", id]);
		return info.ok;
	}

	async function pruneAgentPanes(): Promise<void> {
		for (let index = agentPaneStack.length - 1; index >= 0; index--) {
			const paneId = agentPaneStack[index];
			if (paneId && !(await paneAlive(paneId))) {
				agentPaneStack.splice(index, 1);
				panes.forgetTarget(paneId);
			}
		}
	}

	async function startAgentPane(
		name: string,
		label: string,
		cwd: string,
		argv: string[],
	): Promise<string> {
		const predecessor = agentStartQueue;
		let release!: () => void;
		agentStartQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await predecessor;
		try {
			return await startAgentPaneUnlocked(name, label, cwd, argv);
		} finally {
			release();
		}
	}

	async function startAgentPaneUnlocked(
		name: string,
		label: string,
		cwd: string,
		argv: string[],
	): Promise<string> {
		await pruneAgentPanes();
		// herdr >= 0.8 signature: the pane is always created first, then
		// `agent start <name> --kind KIND --pane ID -- <agent-args>` where the
		// binary comes from --kind and agent-args must not repeat it.
		const kind = (argv[0] ?? "").split("/").pop() ?? "";
		if (!kind) throw new Error("agent command is empty");
		const agentArgs = argv.slice(1);
		const workerPane = await panes.splitOff(cwd, agentPaneStack);
		// Shell startup can briefly report one foreground zsh before later init
		// jobs run. process-info is therefore only a cheap gate; Herdr's own
		// `agent start` precondition is authoritative. Retry only its exact
		// unavailable-shell refusal, on the same pane, until startup settles.
		let started: CliResult | undefined;
		for (let attempt = 0; attempt < SHELL_READY_ATTEMPTS; attempt++) {
			const info = await cli.exec(["pane", "process-info", "--pane", workerPane]);
			if (info.ok && isIdleShell(info.json)) {
				started = await cli.exec(
					["agent", "start", name, "--kind", kind, "--pane", workerPane, "--", ...agentArgs],
					{ timeoutMs: AGENT_START_TIMEOUT_MS },
				);
				if (started.ok || !isUnavailableShell(started)) break;
			}
			if (attempt + 1 < SHELL_READY_ATTEMPTS) {
				await new Promise((resolvePromise) => setTimeout(resolvePromise, SHELL_READY_POLL_MS));
			}
		}
		if (!started?.ok) {
			// Do not leak the split pane when the start is refused.
			void cli.exec(["pane", "close", workerPane]);
			panes.forgetTarget(workerPane);
			const detail = started?.errorMessage ?? started?.stderr.trim() ?? "shell readiness timed out";
			throw new Error(`herdr agent start failed: ${detail}`);
		}
		const pane = findString(started.json, "pane_id") ?? workerPane;
		// The pre-split pane carries no label; restore the old auto-labeled UX.
		void cli.exec(["pane", "rename", pane, label]);
		agentPaneStack.unshift(pane);
		return pane;
	}

	function toast(title: string, body: string, sound: "none" | "done" | "request"): void {
		if (!toasts) return;
		void cli.exec(["notification", "show", title, "--body", body, "--sound", sound]);
	}

	async function readPane(paneId: string, lines = READ_LINES): Promise<string> {
		const result = await cli.exec([
			"pane",
			"read",
			paneId,
			"--source",
			"recent-unwrapped",
			"--lines",
			String(lines),
			"--format",
			"text",
		]);
		return result.ok || result.stdout ? result.stdout.replace(/\n+$/, "") : "";
	}

	async function startCommandRun(
		options: StartOptions,
		controller: RunController,
	): Promise<DriverHandle> {
		const { record } = controller;
		const paneLabel = `▶ ${record.label}`;
		const { paneId, reused } = await panes.acquire(options.cwd, paneLabel);
		record.paneId = paneId;

		const wrapped = wrapRunCommand({
			id: record.id,
			command: options.command,
			...(reused ? { cd: options.cwd } : {}),
		});
		const ran = await cli.exec(["pane", "run", paneId, wrapped]);
		if (!ran.ok) {
			panes.release(paneId);
			throw new Error(`herdr pane run failed: ${ran.errorMessage ?? ran.stderr.trim()}`);
		}

		let finished = false;
		let stopping = false;
		let emittedLines = 0;
		let waiter: Waiter | undefined;
		let waiterRetryTimer: NodeJS.Timeout | undefined;
		let waiterFailureCount = 0;
		let reconcilingWaiterFailure = false;
		const timers: NodeJS.Timeout[] = [];
		const waiterArgs = [
			"pane",
			"wait-output",
			paneId,
			"--regex",
			exitMatchPattern(record.id),
			"--timeout",
			String(WAIT_FOREVER_MS),
		];

		async function readSnapshot(lines?: number): Promise<string> {
			return readPane(paneId, lines);
		}

		async function readOutput(lines?: number): Promise<string> {
			return extractRunOutput(record.id, await readSnapshot(lines));
		}

		function completedSnapshot(
			snapshot: string,
		): { exitCode: number; output: string } | undefined {
			const matched = snapshot.match(new RegExp(exitMatchPattern(record.id)))?.[0];
			if (!matched) return undefined;
			const exitCode = parseExitCode(record.id, matched);
			if (exitCode === undefined) return undefined;
			return { exitCode, output: extractRunOutput(record.id, snapshot) };
		}

		function cancelWaiterSupervision(): void {
			if (waiterRetryTimer) {
				clearTimeout(waiterRetryTimer);
				waiterRetryTimer = undefined;
			}
			const current = waiter;
			waiter = undefined;
			current?.kill();
		}

		function scheduleWaiterRetry(): void {
			if (finished || stopping || waiter || waiterRetryTimer) return;
			const delay = Math.min(
				COMMAND_WAITER_RETRY_BASE_MS * 2 ** Math.min(waiterFailureCount, 6),
				COMMAND_WAITER_RETRY_MAX_MS,
			);
			waiterFailureCount += 1;
			waiterRetryTimer = setTimeout(() => {
				waiterRetryTimer = undefined;
				startWaiter();
			}, delay);
		}

		function recoverWaiterFailure(): void {
			scheduleWaiterRetry();
			if (reconcilingWaiterFailure) return;
			reconcilingWaiterFailure = true;
			void (async () => {
				try {
					const snapshot = await readSnapshot().catch(() => undefined);
					if (finished || stopping || snapshot === undefined) return;
					const completed = completedSnapshot(snapshot);
					if (completed) finalize({ exitCode: completed.exitCode }, completed.output, false);
				} finally {
					reconcilingWaiterFailure = false;
				}
			})();
		}

		function startWaiter(): void {
			if (finished || stopping || waiter) return;
			let current: Waiter;
			try {
				current = cli.spawnWaiter(waiterArgs);
			} catch {
				scheduleWaiterRetry();
				return;
			}
			waiter = current;
			void current.promise.then(
				async (result: CliResult) => {
					if (waiter !== current) return;
					waiter = undefined;
					if (finished || stopping) return;
					if (result.ok) {
						const matched = findString(result.json, "matched_line") ?? "";
						const embedded = findString(result.json, "text");
						const snapshot = embedded ?? (await readSnapshot().catch(() => ""));
						if (finished || stopping) return;
						const completed = completedSnapshot(snapshot);
						const exitCode = parseExitCode(record.id, matched) ?? completed?.exitCode;
						if (exitCode === undefined) {
							scheduleWaiterRetry();
							return;
						}
						finalize(
							{ exitCode },
							completed?.output ?? extractRunOutput(record.id, snapshot),
							false,
						);
						return;
					}
					// The waiter is only an observer. A Herdr restart or protocol error
					// does not mean the pane command died, so keep the run supervised.
					recoverWaiterFailure();
				},
				() => {
					if (waiter !== current) return;
					waiter = undefined;
					recoverWaiterFailure();
				},
			);
		}

		function finalize(
			outcome: Parameters<RunController["finish"]>[0],
			finalText: string | undefined,
			paneGone: boolean,
		): void {
			if (finished) return;
			finished = true;
			for (const timer of timers) clearInterval(timer);
			cancelWaiterSupervision();
			if (finalText !== undefined) {
				const lines = finalText.split("\n");
				const fresh = lines.slice(emittedLines).join("\n");
				if (fresh.trim()) controller.emitOutput(`${fresh}\n`);
			}
			if (paneGone) {
				panes.discard(paneId);
			} else {
				const ok = !outcome.killed && outcome.exitCode === 0;
				panes.rename(paneId, `${ok ? "✓" : "✗"} ${record.label}`);
				panes.release(paneId);
			}
			if (record.promoted && !outcome.killed) {
				const ok = outcome.exitCode === 0;
				toast(
					`${ok ? "✓" : "✗"} ${record.label}`,
					`${options.command} — exit ${outcome.exitCode ?? "?"}`,
					ok ? "none" : "done",
				);
			}
			controller.finish(outcome);
		}

		startWaiter();

		timers.push(
			setInterval(() => {
				void (async () => {
					if (finished || stopping) return;
					const info = await cli.exec(["pane", "process-info", "--pane", paneId]);
					if (finished || stopping) return;
					if (!info.ok) {
						if (info.errorCode === "not_found") {
							finalize({ killed: true, note: "pane was closed" }, undefined, true);
						}
						return; // Transient server trouble: try again next tick.
					}
					if (isIdleShell(info.json)) {
						// Shell is back at its prompt but the sentinel never matched:
						// the command was interrupted in the pane. Give the waiter a
						// grace window in case the match is in flight.
						setTimeout(() => {
							void (async () => {
								if (finished || stopping) return;
								const snapshot = await readSnapshot().catch(() => undefined);
								const completed = snapshot === undefined ? undefined : completedSnapshot(snapshot);
								if (completed) {
									finalize({ exitCode: completed.exitCode }, completed.output, false);
									return;
								}
								finalize(
									{ killed: true, note: "command was interrupted in its pane" },
									snapshot === undefined ? undefined : extractRunOutput(record.id, snapshot),
									false,
								);
							})();
						}, INTERRUPT_GRACE_MS);
					}
				})();
			}, SUPERVISE_COMMAND_MS),
		);

		if (options.kind === "watch") {
			timers.push(
				setInterval(() => {
					void (async () => {
						if (finished) return;
						const output = await readOutput(250).catch(() => undefined);
						if (output === undefined || finished) return;
						const lines = output.split("\n");
						if (lines.length < emittedLines) {
							emittedLines = lines.length; // Scrollback trimmed; resync.
							return;
						}
						const fresh = lines.slice(emittedLines);
						if (fresh.length === 0) return;
						emittedLines = lines.length;
						if (fresh.join("").trim()) controller.emitOutput(`${fresh.join("\n")}\n`);
					})();
				}, WATCH_POLL_MS),
			);
		}

		return {
			paneId,
			stop() {
				if (finished || stopping) return;
				stopping = true;
				cancelWaiterSupervision();
				void cli.exec(["pane", "send-keys", paneId, "ctrl+c"]);
				setTimeout(() => {
					void (async () => {
						const output = await readOutput().catch(() => undefined);
						stopping = false;
						finalize({ killed: true, termSignal: "SIGINT" }, output, false);
					})();
				}, STOP_SETTLE_MS);
			},
			detach() {
				finished = true;
				for (const timer of timers) clearInterval(timer);
				cancelWaiterSupervision();
			},
			readLive: (lines) => readOutput(lines),
		};
	}

	async function startAgentRun(
		options: StartOptions,
		controller: RunController,
	): Promise<DriverHandle> {
		const { record } = controller;
		if (!options.prompt) throw new Error("agent runs require a prompt");
		// Fire-and-forget: a hung/unavailable Herdr must not serially delay launches.
		void reapOrphans?.();

		let paneId: string;
		let name: string;
		if (options.reuseName) {
			const existing = await cli.exec(["agent", "get", options.reuseName]);
			if (!existing.ok) {
				throw new Error(
					`no live herdr agent named "${options.reuseName}" — start one by omitting \`name\` or check \`bg_list\``,
				);
			}
			name = options.reuseName;
			paneId = findString(existing.json, "pane_id") ?? "";
		} else {
			const argv = tokenize(options.command);
			if (argv.length === 0) throw new Error("agent command is empty");
			name = agentName(record.label, record.id);
			paneId = await startAgentPane(name, record.label, options.cwd, argv);
		}
		if (!paneId) throw new Error("herdr did not report a pane id for the agent");
		record.paneId = paneId;
		record.agentName = name;
		// Track before the prompt so a later session death can still reap this pane.
		ledger?.track({
			paneId,
			agentName: name,
			runId: record.id,
			label: record.label,
			// Required-artifact runs are closed by this live driver only after
			// validation. A same-process reload must not let the generic reaper
			// close a settled pane without that validation context.
			closeOnSettle: Boolean(options.closeOnSettle && !options.requiredArtifactPath),
		});

		let finished = false;
		const waiters: Waiter[] = [];
		const timers: NodeJS.Timeout[] = [];

		function finalize(
			outcome: Parameters<RunController["finish"]>[0],
			finalText: string | undefined,
		): void {
			if (finished) return;
			finished = true;
			for (const timer of timers) clearInterval(timer);
			for (const waiter of waiters) waiter.kill();
			if (finalText?.trim()) controller.emitOutput(`${finalText}\n`);
			const state = outcome.agentState ?? "unknown";
			if (options.closeOnSettle && (state === "done" || state === "idle")) {
				// Transcript is already captured. Confirm the live occupant still
				// matches this run, then close → forget without blocking settlement.
				void (async () => {
					let got: CliResult;
					try {
						got = await cli.exec(["agent", "get", paneId]);
					} catch {
						return;
					}
					const occupant = occupantFrom(got.json);
					if (!got.ok || !occupant || !isSettledOccupantOf(occupant, paneId, name)) return;
					let closed: CliResult;
					try {
						closed = await cli.exec(["pane", "close", paneId]);
					} catch {
						return;
					}
					if (closed.ok || closed.errorCode === "not_found") ledger?.forget(paneId);
				})();
			}
			if (record.promoted && !outcome.killed) {
				if (state === "blocked") {
					toast(`⧗ ${record.label} needs input`, `agent ${name} is waiting in pane ${paneId}`, "request");
				} else if (state === "done" || state === "idle") {
					toast(`✓ ${record.label}`, `agent ${name} settled (${state})`, "done");
				} else {
					toast(`⚠ ${record.label} needs inspection`, `agent ${name} settled (${state}) in pane ${paneId}`, "request");
				}
			}
			controller.finish(outcome);
		}

		async function settle(
			state: AgentSettledState,
			note?: string,
			capturedOutput?: string,
		): Promise<void> {
			const output = capturedOutput ?? await readPane(paneId).catch(() => undefined);
			let finalState = state;
			let finalNote = note;
			if (
				(state === "done" || state === "idle")
				&& options.requiredArtifactPath
			) {
				const issue = await settlementArtifactIssue(options.requiredArtifactPath);
				if (issue) {
					finalState = "stalled";
					finalNote = `required result artifact is invalid: ${issue}`;
				}
			}
			finalize(
				{
					agentState: finalState,
					...(finalState === "blocked" || finalState === "done" || finalState === "idle"
						? { exitCode: 0 }
						: {}),
					...(finalNote ? { note: finalNote } : {}),
				},
				output,
			);
		}

		function waitForWorking(timeoutMs: number): Promise<CliResult> {
			const waiter = cli.spawnWaiter([
				"agent",
				"wait",
				paneId,
				"--until",
				"working",
				"--timeout",
				String(timeoutMs),
			]);
			waiters.push(waiter);
			return waiter.promise;
		}

		function waitForSettledState(): Promise<{
			state: AgentSettledState;
			note?: string;
		}> {
			const states: AgentSettledState[] = ["done", "idle", "blocked"];
			return new Promise((resolvePromise) => {
				let resolved = false;
				let failures = 0;
				const cycleWaiters: Waiter[] = [];
				for (const state of states) {
					const waiter = cli.spawnWaiter([
						"agent",
						"wait",
						paneId,
						"--until",
						state,
						"--timeout",
						String(WAIT_FOREVER_MS),
					]);
					cycleWaiters.push(waiter);
					waiters.push(waiter);
					void waiter.promise.then((result) => {
						if (resolved || finished) return;
						if (result.ok) {
							resolved = true;
							for (const sibling of cycleWaiters) {
								if (sibling !== waiter) sibling.kill();
							}
							resolvePromise({ state });
							return;
						}
						if (result.errorCode === "cancelled") return;
						failures += 1;
						if (failures >= states.length) {
							resolved = true;
							resolvePromise({
								state: "unknown",
								note: "all status waits failed — herdr may have restarted",
							});
						}
					});
				}
			});
		}

		const beforePromptResult = await cli.exec(["agent", "get", paneId]);
		const beforePrompt = beforePromptResult.ok ? occupantFrom(beforePromptResult.json) : undefined;
		let promptState: ObservedAgentState | undefined;
		let promptFailureNote: string | undefined;

		// Bind submission to an observed post-prompt lifecycle transition. Herdr
		// can otherwise accept text into a composer while a separate working-only
		// waiter misses both an unsubmitted prompt and a fast working → idle turn.
		const prompted = await cli.exec(
			[
				"agent",
				"prompt",
				name,
				options.prompt,
				"--wait",
				"--until",
				"working",
				"--until",
				"done",
				"--until",
				"idle",
				"--until",
				"blocked",
				"--timeout",
				String(AGENT_PROMPT_WAIT_TIMEOUT_MS),
			],
			{ timeoutMs: AGENT_PROMPT_PROCESS_TIMEOUT_MS },
		);
		if (prompted.ok) {
			promptState = observedAgentState(prompted.json);
		} else if (prompted.errorCode === "agent_prompt_stalled") {
			const currentResult = await cli.exec(["agent", "get", paneId]);
			const current = currentResult.ok ? occupantFrom(currentResult.json) : undefined;
			if (isSameOccupant(current, paneId, name) && current?.status === "working") {
				promptState = "working";
			} else if (
				isSameOccupant(beforePrompt, paneId, name)
				&& isSameOccupant(current, paneId, name)
				&& generationChanged(beforePrompt, current)
				&& (current?.status === "done" || current?.status === "idle" || current?.status === "blocked")
			) {
				promptState = current.status;
			} else if (
				isSameOccupant(beforePrompt, paneId, name)
				&& isSameOccupant(current, paneId, name)
				&& typeof beforePrompt?.stateChangeSeq === "number"
				&& beforePrompt.stateChangeSeq === current?.stateChangeSeq
				&& current.status === "idle"
			) {
				// One guarded recovery for the observed Herdr failure mode: the full
				// prompt is visibly left in the unchanged idle agent's composer.
				const entered = await cli.exec(["pane", "send-keys", paneId, "enter"]);
				if (!entered.ok) {
					promptFailureNote = `prompt stalled and Enter recovery failed: ${entered.errorMessage ?? entered.stderr.trim()}`;
				}
			} else {
				promptFailureNote = "prompt submission stalled without a safe same-agent recovery";
			}
		} else {
			throw new Error(`failed to submit prompt: ${prompted.errorMessage ?? prompted.stderr.trim()}`);
		}

		void (async () => {
			if (promptFailureNote) {
				await settle("stalled", promptFailureNote);
				return;
			}
			if (promptState === "done" || promptState === "idle" || promptState === "blocked") {
				await settle(promptState);
				return;
			}
			let workingTimeoutMs = AGENT_WORKING_TIMEOUT_MS;
			let workingObserved = promptState === "working";
			while (!finished) {
				if (!workingObserved) {
					const workingResult = await waitForWorking(workingTimeoutMs);
					if (finished) return;
					if (!workingResult.ok) {
						if (workingResult.errorCode === "cancelled") return;
						const currentResult = await cli.exec(["agent", "get", paneId]);
						const current = currentResult.ok ? occupantFrom(currentResult.json) : undefined;
						if (
							isSameOccupant(current, paneId, name)
							&& generationChanged(beforePrompt, current)
							&& (current?.status === "done" || current?.status === "idle" || current?.status === "blocked")
						) {
							await settle(current.status);
							return;
						}
						if (isSameOccupant(current, paneId, name) && current?.status === "working") {
							workingObserved = true;
							continue;
						}
						const output = await readPane(paneId).catch(() => undefined);
						if (output !== undefined && isCompactionRunning(output)) {
							workingTimeoutMs = WAIT_FOREVER_MS;
							continue;
						}
						await settle(
							"stalled",
							workingTimeoutMs === AGENT_WORKING_TIMEOUT_MS
								? "the prompt did not visibly start a turn within 20s — check the pane"
								: "the agent did not resume after compaction — check the pane",
							output,
						);
						return;
					}
				}
				workingObserved = false;

				const settled = await waitForSettledState();
				if (finished) return;
				const output = await readPane(paneId).catch(() => undefined);
				if (
					(settled.state === "done" || settled.state === "idle")
					&& output !== undefined
					&& isCompactionRunning(output)
				) {
					// Pi can briefly expose an idle/done detector state after an extension
					// aborts a turn to compact. The same live agent will start another turn
					// when compaction queues its continuation, so keep supervising instead
					// of reporting success and closing the pane mid-compaction.
					workingTimeoutMs = WAIT_FOREVER_MS;
					continue;
				}
				await settle(settled.state, settled.note, output);
				return;
			}
		})();

		timers.push(
			setInterval(() => {
				void (async () => {
					if (finished) return;
					const info = await cli.exec(["agent", "get", name]);
					if (finished || info.ok) return;
					if (info.errorCode === "not_found") {
						const output = await readPane(paneId).catch(() => undefined);
						finalize(
							{ killed: true, note: "agent exited or its pane was closed" },
							output,
						);
					}
				})();
			}, SUPERVISE_AGENT_MS),
		);

		return {
			paneId,
			agentName: name,
			stop() {
				if (finished) return;
				void cli.exec(["pane", "send-keys", paneId, "esc"]);
				void (async () => {
					const output = await readPane(paneId).catch(() => undefined);
					finalize(
						{
							killed: true,
							note: "sent esc to interrupt the turn; the agent is still alive in its pane",
						},
						output,
					);
				})();
			},
			detach() {
				finished = true;
				for (const timer of timers) clearInterval(timer);
				for (const waiter of waiters) waiter.kill();
			},
			readLive: (lines) => readPane(paneId, lines),
		};
	}

	return (options, controller) =>
		options.kind === "agent"
			? startAgentRun(options, controller)
			: startCommandRun(options, controller);
}
