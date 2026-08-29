/**
 * @file bg-await.ts — `bg_await`, a quiet waiter for a terminal condition.
 *
 * Replaces sleep/poll loops run through the session: a generated shell loop
 * probes a command on an interval and exits when the condition is met (0),
 * a failure pattern matches (1), or the timeout passes (124). The run is
 * quiet — no viewer pane — and the session is woken exactly once, when the
 * loop exits. Short waits resolve inline without ever detaching.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatDuration, outcomeLabel } from "../format.ts";
import type { Registry } from "../registry.ts";
import type { RunRecord } from "../types.ts";

const AWAIT_SCRIPTS_DIR = join(homedir(), ".pi", "detach", "awaits");
const INLINE_WINDOW_MS = 15_000;
const INLINE_TAIL_LINES = 60;
const DEFAULT_INTERVAL_S = 30;
const DEFAULT_TIMEOUT_S = 1_800;

interface Details {
	runId: string;
	promoted: boolean;
	status: string;
	exitCode?: number;
	durationMs: number;
	command: string;
}

function singleQuoted(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface AwaitScriptOptions {
	command: string;
	untilPattern?: string | undefined;
	failPattern?: string | undefined;
	intervalSeconds: number;
	timeoutSeconds: number;
}

export function buildAwaitScript(options: AwaitScriptOptions): string {
	const lines = [
		"#!/bin/sh",
		`printf '[bg_await] probe: %s\\n' ${singleQuoted(options.command)}`,
		`deadline=$(( $(date +%s) + ${options.timeoutSeconds} ))`,
		"attempt=0",
		"while :; do",
		"  attempt=$((attempt+1))",
		"  out=$( {",
		options.command,
		"} 2>&1 )",
		"  code=$?",
		`  [ -n "$out" ] && printf '[attempt %s | exit %s]\\n%s\\n' "$attempt" "$code" "$out"`,
	];
	if (options.untilPattern) {
		lines.push(
			`  if printf '%s\\n' "$out" | grep -Eiq ${singleQuoted(options.untilPattern)}; then`,
			"    echo '[bg_await] until condition matched'",
			"    exit 0",
			"  fi",
		);
	} else {
		lines.push(
			'  if [ "$code" -eq 0 ]; then',
			"    echo '[bg_await] probe succeeded'",
			"    exit 0",
			"  fi",
		);
	}
	if (options.failPattern) {
		lines.push(
			`  if printf '%s\\n' "$out" | grep -Eiq ${singleQuoted(options.failPattern)}; then`,
			"    echo '[bg_await] failure condition matched'",
			"    exit 1",
			"  fi",
		);
	}
	lines.push(
		`  if [ "$(date +%s)" -ge "$deadline" ]; then`,
		`    echo '[bg_await] timed out after ${options.timeoutSeconds}s'`,
		"    exit 124",
		"  fi",
		`  sleep ${options.intervalSeconds}`,
		"done",
	);
	return `${lines.join("\n")}\n`;
}

function invalidPattern(name: string, pattern: string | undefined): string | undefined {
	if (pattern === undefined) return undefined;
	try {
		new RegExp(pattern, "i");
		return undefined;
	} catch (error) {
		return `${name} is not a valid regex: ${error instanceof Error ? error.message : String(error)}`;
	}
}

function verdict(record: RunRecord, hasUntil: boolean): string {
	if (record.exitCode === 0) return hasUntil ? "Until condition matched" : "Probe succeeded";
	if (record.exitCode === 1) return "Failure condition matched";
	if (record.exitCode === 124) return "Timed out";
	return outcomeLabel(record);
}

export function registerBgAwaitTool(pi: ExtensionAPI, registry: Registry): void {
	pi.registerTool({
		name: "bg_await",
		label: "Detach: Await",
		description:
			"Wait for a terminal condition by probing a command on an interval in the " +
			"background, then wake the session exactly once — when the probe succeeds, " +
			"matches untilPattern, matches failPattern, or times out. Quiet by design: " +
			"no viewer pane, no output between probes. Use it instead of sleep/poll " +
			"loops for CI pipelines, deployments, and slow external state.",
		promptSnippet:
			"bg_await — probe a command until a terminal condition, then get woken once.",
		promptGuidelines: [
			"Use bg_await instead of running sleep-and-check commands yourself; one call replaces the whole poll loop.",
			"Without untilPattern the wait completes when the probe exits 0 — ideal for curl -f health checks.",
			"With untilPattern (POSIX ERE, case-insensitive) the wait completes when a probe output line matches; add failPattern for hard-failure states so a broken pipeline wakes you early.",
			"Progress is visible with bg_output; cancel with bg_stop. Never add your own sleep between checks.",
		],
		parameters: Type.Object({
			command: Type.String({
				description:
					"Probe shell command run once per interval. Its combined output is matched " +
					"against the patterns; without untilPattern, exit code 0 completes the wait.",
			}),
			untilPattern: Type.Optional(
				Type.String({
					description:
						"Case-insensitive POSIX ERE. The wait completes successfully when a probe's " +
						"output matches. Omit to complete when the probe exits 0.",
				}),
			),
			failPattern: Type.Optional(
				Type.String({
					description:
						"Case-insensitive POSIX ERE marking a hard failure. A match ends the wait " +
						"with exit code 1 instead of waiting out the timeout.",
				}),
			),
			intervalSeconds: Type.Optional(
				Type.Integer({
					minimum: 5,
					maximum: 3_600,
					description: "Seconds between probes. Defaults to 30.",
				}),
			),
			timeoutSeconds: Type.Optional(
				Type.Integer({
					minimum: 15,
					maximum: 21_600,
					description: "Overall deadline in seconds. Defaults to 1800 (30 minutes).",
				}),
			),
			cwd: Type.Optional(
				Type.String({ description: "Working directory for the probe. Defaults to the session cwd." }),
			),
			label: Type.Optional(
				Type.String({ description: "Short human-readable name used in notifications." }),
			),
		}),
		executionMode: "parallel",

		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<Details>> {
			const problem =
				invalidPattern("untilPattern", params.untilPattern) ??
				invalidPattern("failPattern", params.failPattern);
			if (problem) {
				return {
					content: [{ type: "text", text: `bg_await rejected: ${problem}` }],
					details: { runId: "", promoted: false, status: "failed", durationMs: 0, command: params.command },
				};
			}

			const cwd = params.cwd
				? isAbsolute(params.cwd)
					? params.cwd
					: resolve(ctx.cwd, params.cwd)
				: ctx.cwd;
			const intervalSeconds = params.intervalSeconds ?? DEFAULT_INTERVAL_S;
			const timeoutSeconds = params.timeoutSeconds ?? DEFAULT_TIMEOUT_S;

			const script = buildAwaitScript({
				command: params.command,
				untilPattern: params.untilPattern,
				failPattern: params.failPattern,
				intervalSeconds,
				timeoutSeconds,
			});
			await mkdir(AWAIT_SCRIPTS_DIR, { recursive: true });
			const scriptPath = join(
				AWAIT_SCRIPTS_DIR,
				`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.sh`,
			);
			await writeFile(scriptPath, script, "utf8");

			const { record, completion } = await registry.start({
				kind: "run",
				command: `sh ${scriptPath}`,
				cwd,
				label: params.label ?? `await · ${params.command.slice(0, 34)}`,
				quiet: true,
			});

			let timer: NodeJS.Timeout | undefined;
			const promoteOnTimeout = new Promise<"promote">((r) => {
				timer = setTimeout(() => r("promote"), INLINE_WINDOW_MS);
			});
			const promoteOnAbort = new Promise<"promote">((r) => {
				if (!signal) return;
				if (signal.aborted) r("promote");
				signal.addEventListener("abort", () => r("promote"), { once: true });
			});
			const outcome = await Promise.race([completion, promoteOnTimeout, promoteOnAbort]);
			if (timer) clearTimeout(timer);

			if (outcome === "promote") {
				registry.markPromoted(record.id);
				return {
					content: [
						{
							type: "text",
							text:
								`Awaiting in the background as ${record.id} — probing every ${intervalSeconds}s, ` +
								`timeout ${timeoutSeconds}s.\n$ ${params.command}\n  cwd: ${cwd}\n` +
								"Quiet until terminal; you will be woken exactly once. Do not poll — " +
								`bg_output({ runId: "${record.id}" }) shows attempts, bg_stop cancels.`,
						},
					],
					details: {
						runId: record.id,
						promoted: true,
						status: "running",
						durationMs: Date.now() - record.startedAt,
						command: params.command,
					},
				};
			}

			const finished = outcome;
			const duration = (finished.endedAt ?? Date.now()) - finished.startedAt;
			const tail = registry.tail(finished.id, INLINE_TAIL_LINES);
			const header = `${verdict(finished, Boolean(params.untilPattern))} in ${formatDuration(duration)}`;
			return {
				content: [{ type: "text", text: tail.trim() ? `${header}\n\n${tail.trimEnd()}` : header }],
				details: {
					runId: finished.id,
					promoted: false,
					status: finished.status,
					...(finished.exitCode !== undefined ? { exitCode: finished.exitCode } : {}),
					durationMs: duration,
					command: params.command,
				},
			};
		},

		renderCall(args) {
			return new Text(`await $ ${args.command}`, 0, 0);
		},

		renderResult(result) {
			const details = result.details as Details | undefined;
			if (!details) return new Text("", 0, 0);
			if (details.promoted) return new Text(`awaiting → ${details.runId}`, 0, 0);
			return new Text(
				`${details.status} ${details.exitCode ?? ""} · ${formatDuration(details.durationMs)}`.trim(),
				0,
				0,
			);
		},
	});
}
