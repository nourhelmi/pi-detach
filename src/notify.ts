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
const ERROR_LINE_COOLDOWN_MS = 60_000;

const CONTINUE_HINT =
	"Informational — continue what you were doing unless you were waiting on this.";

export interface Notifier {
	runFinished(record: RunRecord): void;
	watchErrorLine(record: RunRecord, line: string): void;
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

	return {
		runFinished(record) {
			// Not promoted: the originating bg_run call is still awaiting it inline.
			// Killed: someone asked for this via bg_stop or shutdown, so it is not news.
			if (!record.promoted || record.status === "killed") return;
			const ok = succeeded(record);
			const tail = registry.tail(record.id, ok ? TAIL_ON_SUCCESS : TAIL_ON_FAILURE);
			const lines = [
				`[detach] ${runHeadline(record)}`,
				`$ ${record.command}`,
				`  cwd: ${record.cwd}`,
			];
			if (tail.trim()) {
				lines.push("", tail.trimEnd());
			}
			lines.push("", `Full log: bg_output({ runId: "${record.id}" })`, CONTINUE_HINT);
			deliver("detach_finished", lines.join("\n"), record);
		},

		watchErrorLine(record, line) {
			const now = Date.now();
			const last = lastErrorNotice.get(record.id) ?? 0;
			if (now - last < ERROR_LINE_COOLDOWN_MS) return;
			lastErrorNotice.set(record.id, now);
			const content = [
				`[detach] watch ${record.id} · ${record.label} matched its error pattern:`,
				"",
				line.trim(),
				"",
				`More context: bg_output({ runId: "${record.id}" })`,
				CONTINUE_HINT,
			].join("\n");
			deliver("detach_watch_error", content, record);
		},
	};
}
