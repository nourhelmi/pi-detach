/**
 * @file panes.ts — owns the herdr panes this session creates for runs.
 *
 * Panes are recycled: when a run finishes its pane returns to an idle pool,
 * and the next run reuses it instead of splitting again, so fan-outs don't
 * shred the layout. Reuse is verified against process-info first — if the
 * user started typing or launched something in the pane, it is quietly
 * dropped from the pool. Pooled reuse does not consume the caller-split budget.
 *
 * Layout: the caller (advisor) pane is split at most twice. The first caller
 * split is always `--direction right` so the advisor keeps the left half. The
 * second is `--direction down` and only happens when no created run pane can
 * be the stack target, leaving the advisor at a quarter. After that the caller
 * is never split again — further helpers stack off surviving run panes with
 * the wide/tall heuristic. If nothing remains to stack on, the split fails
 * rather than carving the advisor a third time.
 */

import { findString, type HerdrCli } from "./cli.ts";
import type { HerdrContext } from "./context.ts";

const SHELL_NAMES = new Set(["zsh", "bash", "fish", "sh", "dash", "nu", "pwsh"]);

/** Wide panes split right, tall panes down; terminal cells are ~2x taller than wide. */
const WIDE_RATIO = 2.5;

/** Persistent cap on splits of the caller pane; never decrements as panes close. */
export const CALLER_SPLIT_CAP = 2;

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

export type SplitWithCallerBudgetResult =
	| { ok: true; paneId: string; consumedCallerSplit: boolean }
	| { ok: false; budgetExhausted: boolean; errorMessage: string };

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

/** Fixed directions for the two budgeted caller splits; stacking never uses this. */
export function callerSplitDirection(callerSplitsUsed: number): "right" | "down" {
	return callerSplitsUsed === 0 ? "right" : "down";
}

async function execSplit(
	cli: HerdrCli,
	target: string,
	direction: "right" | "down",
	cwd: string,
): Promise<{ ok: true; paneId: string } | { ok: false; errorMessage: string }> {
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
		return { ok: false, errorMessage: result.errorMessage ?? (result.stderr.trim() || "pane split refused") };
	}
	const paneId = findString(result.json, "pane_id");
	if (!paneId) return { ok: false, errorMessage: "herdr did not report a pane id" };
	return { ok: true, paneId };
}

/**
 * Pick a split target under the caller-split budget.
 *
 * Prefer surviving created panes (newest first, wide/tall heuristic). Only
 * if those all fail — or none exist — spend a caller split (right, then down).
 * A failed stack target does not skip the remaining created panes and jump
 * straight to the caller; the caller is last resort and never a third time.
 */
export async function splitWithCallerBudget(
	cli: HerdrCli,
	cwd: string,
	params: {
		stackTargets: readonly string[];
		callerPaneId: string;
		callerSplitsUsed: number;
	},
): Promise<SplitWithCallerBudgetResult> {
	let lastError = "pane split refused";
	const stackTargets = params.stackTargets.filter((id) => id !== params.callerPaneId);

	for (const target of stackTargets) {
		const direction = await splitDirectionFor(cli, target);
		const attempt = await execSplit(cli, target, direction, cwd);
		if (attempt.ok) return { ok: true, paneId: attempt.paneId, consumedCallerSplit: false };
		lastError = attempt.errorMessage;
	}

	if (params.callerSplitsUsed >= CALLER_SPLIT_CAP) {
		return {
			ok: false,
			budgetExhausted: true,
			errorMessage: "caller pane split budget exhausted and no run pane remains to stack on",
		};
	}

	const direction = callerSplitDirection(params.callerSplitsUsed);
	const attempt = await execSplit(cli, params.callerPaneId, direction, cwd);
	if (attempt.ok) return { ok: true, paneId: attempt.paneId, consumedCallerSplit: true };
	return { ok: false, budgetExhausted: false, errorMessage: attempt.errorMessage || lastError };
}

export function createPaneManager(cli: HerdrCli, ctx: HerdrContext): PaneManager {
	const createdPanes: string[] = [];
	const idle: string[] = [];
	let callerSplits = 0;

	async function split(cwd: string): Promise<string> {
		const outcome = await splitWithCallerBudget(cli, cwd, {
			stackTargets: createdPanes,
			callerPaneId: ctx.paneId,
			callerSplitsUsed: callerSplits,
		});
		if (!outcome.ok) {
			throw new Error(`herdr pane split failed: ${outcome.errorMessage}`);
		}
		if (outcome.consumedCallerSplit) callerSplits += 1;
		return outcome.paneId;
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
