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
	/** Agent runs: successful done/idle settlement triggers automatic pane closure. */
	closeOnSettle?: boolean | undefined;
	exitCode?: number | undefined;
	termSignal?: string | undefined;
	startedAt: number;
	endedAt?: number | undefined;
	/** Detached from the tool call that started it, so completion must be announced. */
	promoted: boolean;
	logPath: string;
	errorPattern?: string;
	/** Watch runs: a matching output line is terminal — notify once and stop the watch. */
	donePattern?: string;
	/** Agent runs: durable result artifact path, kept for post-settlement lookups. */
	resultPath?: string | undefined;
	/** Agent runs: status parsed leniently from the result artifact. */
	resultStatus?: string | undefined;
	/** Agent runs: non-blocking result-template omissions found during settlement. */
	resultNotes?: string[] | undefined;
	/**
	 * Agent runs: the driver's settlement reason (e.g. an invalid result artifact),
	 * so the completion notice can say why a run stalled instead of a generic label.
	 */
	settlementNote?: string | undefined;
	/** Set when a herdr start failed and the run fell back to a local process. */
	fallbackReason?: string | undefined;
	/** Quiet runs never get a viewer pane when promoted (silent waiters). */
	quiet?: boolean | undefined;
}

/** Trusted service-only hooks. Never populated from public tool parameters. */
export interface RuntimeExecutionHooks {
 assertActive(): void;
 recordHandle(handle: { id: string; session: string }): void;
 expectedHandle?: { id: string; session?: string };
 expectedGeneration?: number;
 childrenSettled?(): Promise<boolean>;
 settled(state: AgentSettledState, output: string, generation: number): { terminal: boolean; close: boolean };
 recoveryRequired(): void;
 environment: Record<string, string>;
}

export interface StartOptions {
 runtimeExecution?: RuntimeExecutionHooks;
	kind: RunKind;
	command: string;
	cwd: string;
	label?: string;
	errorPattern?: string;
	/** Watch runs: terminal-condition regex; first match notifies once and stops the watch. */
	donePattern?: string;
	/** Agent runs: the prompt submitted after the agent is ready. */
	prompt?: string;
	/** Agent runs: reuse this live herdr agent instead of starting a new one. */
	reuseName?: string;
	/**
	 * Agent runs: the reused agent settled blocked only because its result artifact said BLOCKED,
	 * so it is idle at its composer; deliver the prompt through the pane when Herdr refuses `agent prompt`.
	 */
	replyToResultBlock?: boolean;
	/** Agent runs: close the dedicated pane after a successful done/idle settlement. */
	closeOnSettle?: boolean;
	/** Agent runs: require this durable result artifact before treating done/idle as success. */
	requiredArtifactPath?: string;
	/** Agent runs: discover a durable result artifact from the Pi session JSONL entry of this type. */
	resultDiscovery?: string;
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
	resultPath?: string;
	resultStatus?: string;
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
	resultStatus?: string;
	resultNotes?: string[];
	/** Appended to the log before handlers fire, e.g. "pane was closed". */
	note?: string;
}

/** Registry-side surface handed to a driver so it can report progress. */
export interface RunController {
	record: RunRecord;
	/** Append output: feeds the log file, the in-memory tail, and errorPattern matching. */
	emitOutput(chunk: string): void;
	/** Report non-terminal progress while the run remains supervised. */
	progress?(note: string): void;
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
 /** Interrupt the current turn. A runtime observer, when supplied, is told how the same occupant settled afterwards. */
 interrupt?: (observer?: InterruptObserver) => Promise<void>;
	/** Abandon supervision without touching the process; used on session shutdown for herdr runs. */
	detach?: () => void;
	/** Live read for runs whose output is not streamed into the registry (herdr panes). */
	readLive?: (lines: number) => Promise<string>;
	/** Exact managed occupant observation. Effective model/effort are deliberately not inferred. */
	runtimeObservation?: () => Promise<{ session: string; generation: number; state: string; runtime?: string }>;
	/** Queue advice to the same managed busy occupant. No lifecycle or assignment mutation. */
	message?: (input: { text: string; target: { session: string; handleId: string; generation: number } }) => Promise<{ status: "queued" | "rejected" | "unknown"; session: string; generation: number; state: string }>;
}

/** Trusted service-only cancellation observer. Settlement after an interrupt is observed, never invented. */
export interface InterruptObserver {
 settled(state: AgentSettledState, output: string, generation: number): void;
 /** The turn had already settled naturally before the interrupt began; no Escape was sent. */
 superseded(): void;
 recoveryRequired(): void;
}

export type DriverStart = (
	options: StartOptions,
	controller: RunController,
) => Promise<DriverHandle>;
