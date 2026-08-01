/**
 * @file panes.ts — owns the herdr panes this session creates for runs.
 *
 * Panes are recycled: when a run finishes its pane returns to an idle pool,
 * and the next run reuses it instead of splitting again, so fan-outs don't
 * shred the layout. Reuse is verified against process-info first — if the
 * user started typing or launched something in the pane, it is quietly
 * dropped from the pool. Splits stack: the first run splits the caller pane
 * (right when wide, down when tall), later ones split the newest run pane.
 */

import { findString, type HerdrCli } from "./cli.ts";
import type { HerdrContext } from "./context.ts";

const SHELL_NAMES = new Set(["zsh", "bash", "fish", "sh", "dash", "nu", "pwsh"]);

/** Wide panes split right, tall panes down; terminal cells are ~2x taller than wide. */
const WIDE_RATIO = 2.5;

export interface AcquiredPane {
	paneId: string;
	reused: boolean;
}

export interface PaneManager {
	acquire(cwd: string, label: string): Promise<AcquiredPane>;
	/** Return a pane to the idle pool after its run finished. */
	release(paneId: string): void;
	/** Forget a pane entirely (closed or unusable). */
	discard(paneId: string): void;
	rename(paneId: string, label: string): void;
	/** Panes created by this manager, newest first. */
	created(): string[];
}

interface ProcessEntry {
	name?: string;
	argv0?: string;
}

export function isIdleShell(json: unknown): boolean {
	const info = json as {
		result?: { process_info?: { foreground_processes?: ProcessEntry[] } };
	};
	const procs = info.result?.process_info?.foreground_processes;
	if (!procs || procs.length !== 1) return false;
	const name = (procs[0]?.name ?? procs[0]?.argv0 ?? "").replace(/^-/, "");
	return SHELL_NAMES.has(name);
}

/** Wide panes split right, narrow or tall panes split down. */
export async function splitDirectionFor(cli: HerdrCli, targetPane: string): Promise<"right" | "down"> {
	const layout = await cli.exec(["pane", "layout", "--pane", targetPane]);
	if (layout.ok) {
		const parsed = layout.json as {
			result?: { layout?: { panes?: { pane_id?: string; rect?: { width?: number; height?: number } }[] } };
		};
		const rect = parsed.result?.layout?.panes?.find((pane) => pane.pane_id === targetPane)?.rect;
		if (rect?.width && rect.height) {
			return rect.width >= rect.height * WIDE_RATIO ? "right" : "down";
		}
	}
	return "right";
}

export function createPaneManager(cli: HerdrCli, ctx: HerdrContext): PaneManager {
	const createdPanes: string[] = [];
	const idle: string[] = [];

	async function split(cwd: string): Promise<string | undefined> {
		// Stack new panes off the newest run pane so the caller keeps its space.
		const target = createdPanes[0] ?? ctx.paneId;
		const direction = await splitDirectionFor(cli, target);
		const result = await cli.exec([
			"pane",
			"split",
			target,
			"--direction",
			direction,
			"--cwd",
			cwd,
			"--no-focus",
		]);
		if (!result.ok) {
			if (target !== ctx.paneId) {
				// The stack target may have been closed by the user; retry off the caller.
				const retry = await cli.exec([
					"pane",
					"split",
					ctx.paneId,
					"--direction",
					await splitDirectionFor(cli, ctx.paneId),
					"--cwd",
					cwd,
					"--no-focus",
				]);
				if (retry.ok) return findString(retry.json, "pane_id");
			}
			return undefined;
		}
		return findString(result.json, "pane_id");
	}

	// The shell needs a beat to print its prompt after the sentinel matches,
	// so a just-released pane can look busy for a few hundred ms.
	async function reusability(paneId: string): Promise<"reuse" | "busy" | "gone"> {
		for (let attempt = 0; attempt < 3; attempt++) {
			if (attempt > 0) await new Promise((r) => setTimeout(r, 250));
			const info = await cli.exec(["pane", "process-info", "--pane", paneId]);
			if (!info.ok) return info.errorCode === "not_found" ? "gone" : "busy";
			if (isIdleShell(info.json)) return "reuse";
		}
		return "busy";
	}

	return {
		async acquire(cwd, label) {
			const candidates = idle.splice(0, idle.length);
			const stillIdle: string[] = [];
			let chosen: string | undefined;
			for (const candidate of candidates) {
				if (chosen) {
					stillIdle.push(candidate);
					continue;
				}
				const state = await reusability(candidate);
				if (state === "reuse") {
					chosen = candidate;
				} else if (state === "busy") {
					// The user may have taken it, or it is still settling; keep it
					// pooled — the process-info gate protects the next attempt.
					stillIdle.push(candidate);
				} else {
					const index = createdPanes.indexOf(candidate);
					if (index >= 0) createdPanes.splice(index, 1);
				}
			}
			idle.push(...stillIdle);
			if (chosen) {
				this.rename(chosen, label);
				return { paneId: chosen, reused: true };
			}
			const paneId = await split(cwd);
			if (!paneId) throw new Error("herdr pane split failed");
			createdPanes.unshift(paneId);
			this.rename(paneId, label);
			return { paneId, reused: false };
		},

		release(paneId) {
			if (createdPanes.includes(paneId) && !idle.includes(paneId)) idle.push(paneId);
		},

		discard(paneId) {
			const index = createdPanes.indexOf(paneId);
			if (index >= 0) createdPanes.splice(index, 1);
			const idleIndex = idle.indexOf(paneId);
			if (idleIndex >= 0) idle.splice(idleIndex, 1);
		},

		rename(paneId, label) {
			void cli.exec(["pane", "rename", paneId, label]);
		},

		created() {
			return [...createdPanes];
		},
	};
}
