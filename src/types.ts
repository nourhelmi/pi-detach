export type RunKind = "run" | "watch" | "agent";

export type RunBackend = "local" | "herdr";

export type RunStatus = "running" | "exited" | "killed";

/** Settled lifecycle state of an agent run, from herdr's semantic detection. */
export type AgentSettledState = "done" | "idle" | "blocked" | "stalled" | "unknown";

export interface RunRecord {
	id: string;
	kind: RunKind;
	command: string;
	cwd: string;
	label: string;
	status: RunStatus;
	backend: RunBackend;
	pid?: number | undefined;
	/** Herdr pane hosting this run, when backend is "herdr". */
	paneId?: string | undefined;
	/** Live herdr agent name, when kind is "agent". */
	agentName?: string | undefined;
	/** How an agent run settled, when kind is "agent". */
	agentState?: AgentSettledState | undefined;
	exitCode?: number | undefined;
	termSignal?: string | undefined;
	startedAt: number;
	endedAt?: number | undefined;
	/** Detached from the tool call that started it, so completion must be announced. */
	promoted: boolean;
	logPath: string;
	errorPattern?: string;
	/** Set when a herdr start failed and the run fell back to a local process. */
	fallbackReason?: string | undefined;
	/** Quiet runs never get a viewer pane when promoted (silent waiters). */
	quiet?: boolean | undefined;
}

export interface StartOptions {
	kind: RunKind;
	command: string;
	cwd: string;
	label?: string;
	errorPattern?: string;
	/** Agent runs: the prompt submitted after the agent is ready. */
	prompt?: string;
	/** Agent runs: reuse this live herdr agent instead of starting a new one. */
	reuseName?: string;
	/** Agent runs: close the dedicated pane after a successful done/idle settlement. */
	closeOnSettle?: boolean;
	/** Skip the promoted-run viewer pane; the run stays visible in bg_list only. */
	quiet?: boolean;
}

export interface StartResult {
	record: RunRecord;
	/** Resolves when the process exits or the agent settles. */
	completion: Promise<RunRecord>;
	/** True when an identical (cwd, command) run was already active. */
	deduped: boolean;
}

export interface RunSummary {
	id: string;
	kind: RunKind;
	backend: RunBackend;
	label: string;
	command: string;
	cwd: string;
	status: RunStatus;
	paneId?: string;
	agentName?: string;
	agentState?: AgentSettledState;
	exitCode?: number;
	startedAt: number;
	endedAt?: number;
	durationMs: number;
}

/** Outcome a driver reports into the registry when its run finishes. */
export interface DriverOutcome {
	exitCode?: number | undefined;
	termSignal?: string | undefined;
	killed?: boolean;
	agentState?: AgentSettledState;
	/** Appended to the log before handlers fire, e.g. "pane was closed". */
	note?: string;
}

/** Registry-side surface handed to a driver so it can report progress. */
export interface RunController {
	record: RunRecord;
	/** Append output: feeds the log file, the in-memory tail, and errorPattern matching. */
	emitOutput(chunk: string): void;
	/** Report the run finished. Idempotent; the first call wins. */
	finish(outcome: DriverOutcome): void;
}

/** What a driver exposes back to the registry once started. */
export interface DriverHandle {
	pid?: number | undefined;
	paneId?: string | undefined;
	agentName?: string | undefined;
	/** Ask the run to stop (SIGTERM / ctrl+c / esc). Must eventually lead to finish(). */
	stop(): void;
	/** Abandon supervision without touching the process; used on session shutdown for herdr runs. */
	detach?: () => void;
	/** Live read for runs whose output is not streamed into the registry (herdr panes). */
	readLive?: (lines: number) => Promise<string>;
}

export type DriverStart = (
	options: StartOptions,
	controller: RunController,
) => Promise<DriverHandle>;
