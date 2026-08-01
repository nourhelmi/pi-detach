/**
 * @file context.ts — detects whether pi is running inside a herdr-managed pane.
 *
 * Herdr injects HERDR_ENV=1 plus the caller's pane/tab/workspace ids into every
 * managed pane. When they are present, runs are hosted in visible herdr panes;
 * when absent (or PI_DETACH_NO_HERDR=1), everything falls back to the local
 * detached-process backend.
 */

export interface HerdrContext {
	paneId: string;
	tabId?: string | undefined;
	workspaceId?: string | undefined;
	socketPath?: string | undefined;
	session?: string | undefined;
}

export function detectHerdrContext(
	env: Record<string, string | undefined> = process.env,
): HerdrContext | undefined {
	if (env.PI_DETACH_NO_HERDR === "1") return undefined;
	if (env.HERDR_ENV !== "1") return undefined;
	const paneId = env.HERDR_PANE_ID;
	if (!paneId) return undefined;
	return {
		paneId,
		tabId: env.HERDR_TAB_ID,
		workspaceId: env.HERDR_WORKSPACE_ID,
		socketPath: env.HERDR_SOCKET_PATH,
		session: env.HERDR_SESSION,
	};
}

/** Herdr TUI toasts on run completion; disable with PI_DETACH_HERDR_TOAST=0. */
export function toastsEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return env.PI_DETACH_HERDR_TOAST !== "0";
}
