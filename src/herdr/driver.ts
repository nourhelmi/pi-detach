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
 * Agent runs (`bg_agent`) start a real agent with `herdr agent start`, submit
 * the prompt with `pane run`, confirm the agent went `working`, then race
 * blocking waits on done/idle/blocked and report how it settled.
 */

import { type CliResult, findString, type HerdrCli, type Waiter } from "./cli.ts";
import { type HerdrContext, toastsEnabled } from "./context.ts";
import { isIdleShell, type PaneManager, splitDirectionFor } from "./panes.ts";
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
const AGENT_START_TIMEOUT_MS = 45_000;
const ADVISOR_SPLIT_CAP = 2;
const AGENT_WORKING_TIMEOUT_MS = 20_000;
// herdr 0.8 waits require an explicit --timeout; emulate the old indefinite wait.
const WAIT_FOREVER_MS = 7 * 24 * 60 * 60 * 1000;
const SHELL_READY_ATTEMPTS = 20;
const SHELL_READY_POLL_MS = 250;
const PI_PROMPT_RETRY_MS = 1_500;
const READ_LINES = 400;

export interface HerdrDriverDeps {
	cli: HerdrCli;
	ctx: HerdrContext;
	panes: PaneManager;
	env?: Record<string, string | undefined>;
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

function isPiAgentCommand(command: string): boolean {
	const executable = tokenize(command)[0];
	return executable?.split("/").at(-1) === "pi";
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

export function createHerdrDriver(deps: HerdrDriverDeps): DriverStart {
	const { cli, ctx, panes } = deps;
	const toasts = toastsEnabled(deps.env ?? process.env);

	// Layout policy: the caller (advisor) pane is split directly at most
	// ADVISOR_SPLIT_CAP times — one right + one down, quarter screen worst
	// case. Additional parallel agents split off the newest live worker pane
	// so the caller keeps its space. Closed panes free their slot.
	const agentPaneStack: { paneId: string; offAdvisor: boolean }[] = [];

	async function paneAlive(id: string): Promise<boolean> {
		const info = await cli.exec(["pane", "process-info", "--pane", id]);
		return info.ok;
	}

	async function pruneAgentPanes(): Promise<void> {
		for (let index = agentPaneStack.length - 1; index >= 0; index--) {
			const tracked = agentPaneStack[index];
			if (tracked && !(await paneAlive(tracked.paneId))) agentPaneStack.splice(index, 1);
		}
	}

	async function startAgentPane(
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
		const advisorSplits = agentPaneStack.filter((pane) => pane.offAdvisor).length;
		const stackTarget = advisorSplits >= ADVISOR_SPLIT_CAP ? agentPaneStack[0] : undefined;
		const splitBase = stackTarget?.paneId ?? ctx.paneId;
		const offAdvisor = !stackTarget;
		const direction = await splitDirectionFor(cli, splitBase);
		const split = await cli.exec([
			"pane",
			"split",
			splitBase,
			"--direction",
			direction,
			"--cwd",
			cwd,
			"--no-focus",
		]);
		const workerPane = split.ok ? findString(split.json, "pane_id") : undefined;
		if (!workerPane) {
			throw new Error(`herdr pane split failed: ${split.errorMessage ?? split.stderr.trim()}`);
		}
		// A just-split pane's shell may not be ready; herdr refuses `agent start`
		// with "not an available shell" until it is.
		for (let attempt = 0; attempt < SHELL_READY_ATTEMPTS; attempt++) {
			const info = await cli.exec(["pane", "process-info", "--pane", workerPane]);
			if (info.ok && isIdleShell(info.json)) break;
			await new Promise((resolvePromise) => setTimeout(resolvePromise, SHELL_READY_POLL_MS));
		}
		const started = await cli.exec(
			["agent", "start", name, "--kind", kind, "--pane", workerPane, "--", ...agentArgs],
			{ timeoutMs: AGENT_START_TIMEOUT_MS },
		);
		if (!started.ok) {
			// Do not leak the split pane when the start is refused.
			void cli.exec(["pane", "close", workerPane]);
			throw new Error(`herdr agent start failed: ${started.errorMessage ?? started.stderr.trim()}`);
		}
		const pane = findString(started.json, "pane_id") ?? workerPane;
		// The pre-split pane carries no label; restore the old auto-labeled UX.
		void cli.exec(["pane", "rename", pane, label]);
		agentPaneStack.unshift({ paneId: pane, offAdvisor });
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
		const paneLabel = `▶ ${record.label} · ${record.id}`;
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

		const waiter: Waiter = cli.spawnWaiter([
			"pane",
			"wait-output",
			paneId,
			"--regex",
			exitMatchPattern(record.id),
			"--timeout",
			String(WAIT_FOREVER_MS),
		]);

		const timers: NodeJS.Timeout[] = [];

		async function readOutput(lines?: number): Promise<string> {
			const snapshot = await readPane(paneId, lines);
			return extractRunOutput(record.id, snapshot);
		}

		function finalize(
			outcome: Parameters<RunController["finish"]>[0],
			finalText: string | undefined,
			paneGone: boolean,
		): void {
			if (finished) return;
			finished = true;
			for (const timer of timers) clearInterval(timer);
			waiter.kill();
			if (finalText !== undefined) {
				const lines = finalText.split("\n");
				const fresh = lines.slice(emittedLines).join("\n");
				if (fresh.trim()) controller.emitOutput(`${fresh}\n`);
			}
			if (paneGone) {
				panes.discard(paneId);
			} else {
				const ok = !outcome.killed && outcome.exitCode === 0;
				panes.rename(paneId, `${ok ? "✓" : "✗"} ${record.label} · ${record.id}`);
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

		void waiter.promise.then(async (result: CliResult) => {
			if (finished || stopping) return;
			if (result.ok) {
				const matched = findString(result.json, "matched_line") ?? "";
				const exitCode = parseExitCode(record.id, matched);
				const embedded = findString(result.json, "text");
				const output = embedded
					? extractRunOutput(record.id, embedded)
					: await readOutput();
				finalize({ exitCode }, output, false);
				return;
			}
			if (result.errorCode === "cancelled") return;
			// The wait died while the run may still be going (herdr restart,
			// protocol error). Capture what we can and settle as unsupervised.
			const output = await readOutput().catch(() => undefined);
			finalize(
				{ killed: true, note: `herdr wait failed: ${result.errorMessage ?? "unknown error"}` },
				output,
				false,
			);
		});

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
								const output = await readOutput().catch(() => undefined);
								finalize(
									{ killed: true, note: "command was interrupted in its pane" },
									output,
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
				waiter.kill();
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
				waiter.kill();
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

		const prompted = await cli.exec(["pane", "run", paneId, options.prompt]);
		if (!prompted.ok) {
			throw new Error(`failed to submit prompt: ${prompted.errorMessage ?? prompted.stderr.trim()}`);
		}

		let finished = false;
		const waiters: Waiter[] = [];
		const timers: NodeJS.Timeout[] = [];
		if (isPiAgentCommand(options.command)) {
			// A multiline Pi skill command can remain in the editor after pane run.
			// Retry one Enter only while Herdr still reports idle; never interrupt a
			// working or already-completed turn.
			timers.push(
				setTimeout(() => {
					void (async () => {
						if (finished) return;
						const info = await cli.exec(["agent", "get", name]);
						if (findString(info.json, "agent_status") === "idle") {
							await cli.exec(["pane", "send-keys", paneId, "enter"]);
						}
					})();
				}, PI_PROMPT_RETRY_MS),
			);
		}

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
				// The transcript is already captured and the Pi session remains persisted;
				// close successful graph nodes so they never crowd the advisor layout.
				void cli.exec(["pane", "close", paneId]);
			}
			if (record.promoted && !outcome.killed) {
				if (state === "blocked") {
					toast(`⧗ ${record.label} needs input`, `agent ${name} is waiting in pane ${paneId}`, "request");
				} else {
					toast(`✓ ${record.label}`, `agent ${name} settled (${state})`, "done");
				}
			}
			controller.finish(outcome);
		}

		async function settle(state: AgentSettledState, note?: string): Promise<void> {
			const output = await readPane(paneId).catch(() => undefined);
			finalize(
				{
					agentState: state,
					...(state === "blocked" || state === "done" || state === "idle"
						? { exitCode: 0 }
						: {}),
					...(note ? { note } : {}),
				},
				output,
			);
		}

		void (async () => {
			const working = cli.spawnWaiter([
				"agent",
				"wait",
				paneId,
				"--until",
				"working",
				"--timeout",
				String(AGENT_WORKING_TIMEOUT_MS),
			]);
			waiters.push(working);
			const workingResult = await working.promise;
			if (finished) return;
			if (!workingResult.ok) {
				if (workingResult.errorCode === "cancelled") return;
				await settle(
					"stalled",
					"the prompt did not visibly start a turn within 20s — check the pane",
				);
				return;
			}
			const states: AgentSettledState[] = ["done", "idle", "blocked"];
			let failures = 0;
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
				waiters.push(waiter);
				void waiter.promise.then((result) => {
					if (finished) return;
					if (result.ok) {
						void settle(state);
					} else if (result.errorCode !== "cancelled") {
						failures += 1;
						if (failures >= states.length) {
							void settle("unknown", "all status waits failed — herdr may have restarted");
						}
					}
				});
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
