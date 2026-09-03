/**
 * @file notify.ts — delivers completion news back into the session.
 *
 * Delivery mode is the whole point of this extension: when the agent is idle
 * the message starts a fresh turn, and when it is mid-stream the message is
 * steered into the running turn. Either way nothing polls and nothing is
 * spent waiting.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runHeadline, succeeded } from "./format.ts";
import type { Registry } from "./registry.ts";
import type { RunRecord } from "./types.ts";

const TAIL_ON_SUCCESS = 25;
const TAIL_ON_FAILURE = 80;
const TAIL_ON_AGENT = 120;
const ERROR_LINE_COOLDOWN_MS = 60_000;

const CONTINUE_HINT =
	"Informational — continue what you were doing unless you were waiting on this.";

export interface Notifier {
	runFinished(record: RunRecord): void;
	agentPaused(record: RunRecord, note: string): void;
	watchErrorLine(record: RunRecord, line: string): void;
	watchDoneLine(record: RunRecord, line: string): void;
}

function paneHint(record: RunRecord): string[] {
	if (!record.paneId) return [];
	// A successful run's viewer pane closes itself right after this message.
	if (record.kind === "run" && record.status === "exited" && record.exitCode === 0) return [];
	return [`  pane: ${record.paneId} (visible in herdr)`];
}

export function createNotifier(
	pi: ExtensionAPI,
	registry: Registry,
	getContext: () => ExtensionContext | undefined,
): Notifier {
	const lastErrorNotice = new Map<string, number>();

	function deliver(customType: string, content: string, details: unknown): void {
		const idle = getContext()?.isIdle() ?? true;
		pi.sendMessage(
			{ customType, content, display: true, details },
			idle ? { triggerTurn: true } : { deliverAs: "steer" },
		);
	}

	function agentFinished(record: RunRecord): void {
		const tail = registry.tail(record.id, TAIL_ON_AGENT);
		const state = record.agentState ?? "unknown";
		const headlineByState: Record<string, string> = {
			done: "finished its task",
			idle: "finished and is idle",
			blocked: "is BLOCKED waiting for input",
			stalled: "did not visibly start working — the prompt may not have registered",
			unknown: "settled in an unknown state",
		};
		const lines = [
			`[detach] agent ${record.id} · ${record.label} (${record.agentName ?? "?"}) ${headlineByState[state] ?? state}` +
				(record.resultStatus ? ` · result Status: ${record.resultStatus}` : ""),
			...paneHint(record),
			...(record.resultPath ? [`Result artifact: ${record.resultPath}`] : []),
		];
		if (tail.trim()) {
			lines.push("", tail.trimEnd());
		}
		lines.push("");
		if (state === "blocked") {
			lines.push(
				`It needs an answer. Reply with bg_agent({ name: "${record.agentName}", prompt: "…" }), ` +
					`or use the herdr CLI (\`herdr pane run ${record.paneId} "…"\` / \`herdr pane send-keys ${record.paneId} <key>\`) for menu-style prompts.`,
			);
		} else if (state === "done" || state === "idle") {
			if (record.closeOnSettle) {
				lines.push(
					`Full transcript: bg_output({ runId: "${record.id}" }). ` +
						"Its successful tab is being closed automatically. Launch a fresh agent for any follow-up (omit `name`).",
				);
			} else {
				lines.push(
					`Full transcript: bg_output({ runId: "${record.id}" }). ` +
						`Follow up with bg_agent({ name: "${record.agentName}", prompt: "…", keepAlive: true }) — its tab was kept available.`,
				);
			}
		} else {
			lines.push(
				`Full transcript: bg_output({ runId: "${record.id}" }). ` +
					`Its tab remains visible for inspection; if the agent is still responsive, follow up with bg_agent({ name: "${record.agentName}", prompt: "…" }).`,
			);
		}
		lines.push(CONTINUE_HINT);
		deliver("detach_agent_settled", lines.join("\n"), record);
	}

	return {
		runFinished(record) {
			// Not promoted: the originating call is still awaiting it inline.
			// Killed: someone asked for this via bg_stop or shutdown, so it is not news.
			if (!record.promoted || record.status === "killed") return;
			if (record.kind === "agent") {
				agentFinished(record);
				return;
			}
			const ok = succeeded(record);
			const tail = registry.tail(record.id, ok ? TAIL_ON_SUCCESS : TAIL_ON_FAILURE);
			const lines = [
				`[detach] ${runHeadline(record)}`,
				`$ ${record.command}`,
				`  cwd: ${record.cwd}`,
				...paneHint(record),
			];
			if (tail.trim()) {
				lines.push("", tail.trimEnd());
			}
			lines.push("", `Full log: bg_output({ runId: "${record.id}" })`, CONTINUE_HINT);
			deliver("detach_finished", lines.join("\n"), record);
		},

		agentPaused(record, _note) {
			const lines = [
				`[detach] agent ${record.id} · ${record.label} (${record.agentName ?? "?"}) paused after a turn — result Status: "${record.resultStatus ?? "IN PROGRESS"}". It is waiting on its own background work; supervision continues and you will be woken when its result becomes terminal or it blocks.`,
				`If its pane is idle with no background work of its own, the Status line is stale: follow up with bg_agent({ name: "${record.agentName}", prompt: "…" }) to have it finalize the result, or bg_stop({ runId: "${record.id}" }).`,
				...paneHint(record),
				...(record.resultPath ? [`Result artifact: ${record.resultPath}`] : []),
				CONTINUE_HINT,
			];
			deliver("detach_agent_paused", lines.join("\n"), record);
		},

		watchErrorLine(record, line) {
			const now = Date.now();
			const last = lastErrorNotice.get(record.id) ?? 0;
			if (now - last < ERROR_LINE_COOLDOWN_MS) return;
			lastErrorNotice.set(record.id, now);
			const content = [
				`[detach] watch ${record.id} · ${record.label} matched its error pattern:`,
				...paneHint(record),
				"",
				line.trim(),
				"",
				`More context: bg_output({ runId: "${record.id}" })`,
				CONTINUE_HINT,
			].join("\n");
			deliver("detach_watch_error", content, record);
		},

		watchDoneLine(record, line) {
			const content = [
				`[detach] watch ${record.id} · ${record.label} matched its done pattern — the watch is terminal and is being stopped:`,
				...paneHint(record),
				"",
				line.trim(),
				"",
				`Full log: bg_output({ runId: "${record.id}" })`,
				CONTINUE_HINT,
			].join("\n");
			deliver("detach_watch_done", content, record);
		},
	};
}
