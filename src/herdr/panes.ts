/**
 * @file panes.ts — owns the herdr panes this session creates for runs.
 *
 * Panes are recycled: when a run finishes its pane returns to an idle pool,
 * and the next run reuses it instead of splitting again, so fan-outs don't
 * shred the layout. Reuse is verified against process-info first — if the
 * user started typing or launched something in the pane, it is quietly
 * dropped from the pool.
 *
 * Layout: helpers stay inside the caller's tab and prefer stacking off
 * surviving run panes with the wide/tall heuristic, so the caller (advisor)
 * pane is only split when no run pane can host the split. There is no hard
 * cap and no failure path: a launch always gets a pane. Caller splits stay
 * tidy by tracking LIVE caller children — the first concurrent split goes
 * right (advisor keeps the left half), the second goes down, and any further
 * concurrent split follows the caller's live wide/tall geometry. Because each
 * new pane immediately becomes a stack target, deep concurrent carving of the
 * caller only happens when every other pane is gone or refuses to split.
 *
 * One coordinator per manager owns that bookkeeping and the surviving
 * created-pane list. The driver allocates through the same coordinator so
 * mixed watch/viewer/agent fan-out shares one view. Allocations are
 * serialized; the idle pool and the agent stack stay separate.
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
	/**
	 * Allocate stack-first through the shared coordinator. `preferredStack` is
	 * tried first (agent panes stay off the idle pool); other surviving created
	 * panes are fallback targets; the caller pane is the last resort.
	 */
	splitOff(cwd: string, preferredStack: readonly string[]): Promise<string>;
	/** Drop a pane from the shared surviving-target view (agent close/fail). */
	forgetTarget(paneId: string): void;
}

interface ProcessEntry {
	name?: string;
	argv0?: string;
}

export type SplitStackFirstResult =
	| { ok: true; paneId: string; consumedCallerSplit: boolean }
	| { ok: false; errorMessage: string };

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

/**
 * Direction for a caller split, by LIVE caller children: right when the
 * caller is whole, down beside one live child, then live geometry.
 */
export async function callerSplitDirection(
	cli: HerdrCli,
	callerPaneId: string,
	liveCallerSplits: number,
): Promise<"right" | "down"> {
	if (liveCallerSplits === 0) return "right";
	if (liveCallerSplits === 1) return "down";
	return splitDirectionFor(cli, callerPaneId);
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
 * Pick a split target, stack-first.
 *
 * Prefer surviving created panes (newest first, wide/tall heuristic). Only if
 * those all fail — or none exist — split the caller. A failed stack target
 * does not skip the remaining created panes and jump straight to the caller;
 * the caller is last resort, but always available: a launch never fails just
 * because earlier panes closed.
 */
export async function splitStackFirst(
	cli: HerdrCli,
	cwd: string,
	params: {
		stackTargets: readonly string[];
		callerPaneId: string;
		liveCallerSplits: number;
	},
): Promise<SplitStackFirstResult> {
	let lastError = "pane split refused";
	const stackTargets = params.stackTargets.filter((id) => id !== params.callerPaneId);

	for (const target of stackTargets) {
		const direction = await splitDirectionFor(cli, target);
		const attempt = await execSplit(cli, target, direction, cwd);
		if (attempt.ok) return { ok: true, paneId: attempt.paneId, consumedCallerSplit: false };
		lastError = attempt.errorMessage;
	}

	const direction = await callerSplitDirection(cli, params.callerPaneId, params.liveCallerSplits);
	const attempt = await execSplit(cli, params.callerPaneId, direction, cwd);
	if (attempt.ok) return { ok: true, paneId: attempt.paneId, consumedCallerSplit: true };
	return { ok: false, errorMessage: attempt.errorMessage || lastError };
}

/** Preferred stack first, then other surviving created panes, de-duped. */
function stackTargetsFor(
	preferredStack: readonly string[],
	surviving: readonly string[],
	callerPaneId: string,
): string[] {
	const seen = new Set<string>([callerPaneId]);
	const targets: string[] = [];
	for (const id of [...preferredStack, ...surviving]) {
		if (seen.has(id)) continue;
		seen.add(id);
		targets.push(id);
	}
	return targets;
}

/**
 * Shared caller-split bookkeeping + surviving-target view for every allocator
 * of this `ctx.paneId`. The mutex covers the full split bookkeeping so a
 * concurrent acquire cannot both observe 0 and both split `--direction right`.
 */
function createCallerSplitCoordinator(cli: HerdrCli, ctx: HerdrContext) {
	const callerPaneId = ctx.paneId;
	const surviving: string[] = [];
	// Live caller children; only used to pick tidy split directions.
	const callerChildren = new Set<string>();
	let tail = Promise.resolve();

	async function exclusive<T>(work: () => Promise<T>): Promise<T> {
		const predecessor = tail;
		let release!: () => void;
		tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await predecessor;
		try {
			return await work();
		} finally {
			release();
		}
	}

	function forget(paneId: string): void {
		const index = surviving.indexOf(paneId);
		if (index >= 0) surviving.splice(index, 1);
		callerChildren.delete(paneId);
	}

	async function splitUnlocked(cwd: string, preferredStack: readonly string[]): Promise<string> {
		const outcome = await splitStackFirst(cli, cwd, {
			stackTargets: stackTargetsFor(preferredStack, surviving, callerPaneId),
			callerPaneId,
			liveCallerSplits: callerChildren.size,
		});
		if (!outcome.ok) {
			throw new Error(`herdr pane split failed: ${outcome.errorMessage}`);
		}
		if (outcome.consumedCallerSplit) callerChildren.add(outcome.paneId);
		// Publish before the mutex releases so the next allocator stacks here.
		surviving.unshift(outcome.paneId);
		return outcome.paneId;
	}

	return {
		exclusive,
		forget,
		splitUnlocked,
		split: (cwd: string, preferredStack: readonly string[]) =>
			exclusive(() => splitUnlocked(cwd, preferredStack)),
	};
}

export function createPaneManager(cli: HerdrCli, ctx: HerdrContext): PaneManager {
	const createdPanes: string[] = [];
	const idle: string[] = [];
	const coordinator = createCallerSplitCoordinator(cli, ctx);

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
			// Full acquire is serialized so pool checks and splits share one view.
			return coordinator.exclusive(async () => {
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
						coordinator.forget(candidate);
					}
				}
				idle.push(...stillIdle);
				if (chosen) {
					this.rename(chosen, label);
					return { paneId: chosen, reused: true };
				}
				const paneId = await coordinator.splitUnlocked(cwd, createdPanes);
				createdPanes.unshift(paneId);
				this.rename(paneId, label);
				return { paneId, reused: false };
			});
		},

		splitOff(cwd, preferredStack) {
			return coordinator.split(cwd, preferredStack);
		},

		forgetTarget(paneId) {
			coordinator.forget(paneId);
		},

		release(paneId) {
			if (createdPanes.includes(paneId) && !idle.includes(paneId)) idle.push(paneId);
		},

		discard(paneId) {
			const index = createdPanes.indexOf(paneId);
			if (index >= 0) createdPanes.splice(index, 1);
			const idleIndex = idle.indexOf(paneId);
			if (idleIndex >= 0) idle.splice(idleIndex, 1);
			coordinator.forget(paneId);
		},

		rename(paneId, label) {
			void cli.exec(["pane", "rename", paneId, label]);
		},

		created() {
			return [...createdPanes];
		},
	};
}
