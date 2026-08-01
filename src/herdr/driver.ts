/**
 * @file driver.ts — hosts runs in visible herdr panes.
 *
 * Command runs (`bg_run`/`bg_watch`) are typed into a pane and completion is
 * detected via the sentinel + a blocking `herdr wait output` child. Ctrl+C in
 * the pane kills the sentinel along with the command, so a slow supervisor
 * poll watches process-info and settles the run as killed when the shell is
 * back at its prompt without a sentinel having matched.
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
const AGENT_WORKING_TIMEOUT_MS = 20_000;
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
			"wait",
			"output",
			paneId,
			"--match",
			exitMatchPattern(record.id),
			"--regex",
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
			const direction = await splitDirectionFor(cli, ctx.paneId);
			const started = await cli.exec(
				[
					"agent",
					"start",
					name,
					"--cwd",
					options.cwd,
					"--split",
					direction,
					"--no-focus",
					"--",
					...argv,
				],
				{ timeoutMs: AGENT_START_TIMEOUT_MS },
			);
			if (!started.ok) {
				throw new Error(
					`herdr agent start failed: ${started.errorMessage ?? started.stderr.trim()}`,
				);
			}
			paneId = findString(started.json, "pane_id") ?? "";
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

		function finalize(
			outcome: Parameters<RunController["finish"]>[0],
			finalText: string | undefined,
		): void {
			if (finished) return;
			finished = true;
			for (const timer of timers) clearInterval(timer);
			for (const waiter of waiters) waiter.kill();
			if (finalText?.trim()) controller.emitOutput(`${finalText}\n`);
			if (record.promoted && !outcome.killed) {
				const state = outcome.agentState ?? "unknown";
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
				"wait",
				"agent-status",
				paneId,
				"--status",
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
				const waiter = cli.spawnWaiter(["wait", "agent-status", paneId, "--status", state]);
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
