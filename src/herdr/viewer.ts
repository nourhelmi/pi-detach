/**
 * @file viewer.ts — live viewer panes for promoted bg_run commands.
 *
 * Claude Code semantics: foreground work is invisible, and a visible surface
 * appears only when a run actually becomes a background task. bg_run commands
 * execute as ordinary local processes; when one crosses the promote threshold
 * a pane opens tailing its log. On success (or a deliberate stop) the pane
 * closes itself — like a task chip completing. On failure it stays, renamed
 * `✗`, for inspection, and is recycled by the next promoted run.
 */

import type { HerdrCli } from "./cli.ts";
import type { PaneManager } from "./panes.ts";
import type { RunRecord } from "../types.ts";

/** Let tail print the run's last lines before the pane is torn down. */
const TAIL_FLUSH_MS = 400;

export interface ViewerManager {
	/** Attach a live viewer pane to a promoted, still-running local run. */
	attach(record: RunRecord, completion: Promise<RunRecord>): void;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function createViewerManager(cli: HerdrCli, panes: PaneManager): ViewerManager {
	return {
		attach(record, completion) {
			void (async () => {
				if (record.status !== "running" || record.paneId) return;
				let paneId: string;
				try {
					const acquired = await panes.acquire(record.cwd, `▶ ${record.label}`);
					paneId = acquired.paneId;
					const ran = await cli.exec([
						"pane",
						"run",
						paneId,
						`tail -n +1 -f ${shellQuote(record.logPath)}`,
					]);
					if (!ran.ok) throw new Error(ran.errorMessage ?? "pane run failed");
				} catch {
					// No herdr, no viewer — the run itself is unaffected.
					return;
				}
				record.paneId = paneId;

				const finished = await completion;
				await new Promise((r) => setTimeout(r, TAIL_FLUSH_MS));
				await cli.exec(["pane", "send-keys", paneId, "ctrl+c"]);
				const failed = finished.status === "exited" && finished.exitCode !== 0;
				if (failed) {
					panes.rename(paneId, `✗ ${record.label}`);
					panes.release(paneId);
				} else {
					// Success or deliberate stop: the surface disappears with the task.
					await cli.exec(["pane", "close", paneId]);
					panes.discard(paneId);
					record.paneId = undefined;
				}
			})();
		},
	};
}
