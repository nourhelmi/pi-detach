export type RunKind = "run" | "watch";

export type RunStatus = "running" | "exited" | "killed";

export interface RunRecord {
	id: string;
	kind: RunKind;
	command: string;
	cwd: string;
	label: string;
	status: RunStatus;
	pid?: number | undefined;
	exitCode?: number | undefined;
	termSignal?: string | undefined;
	startedAt: number;
	endedAt?: number | undefined;
	/** Detached from the tool call that started it, so completion must be announced. */
	promoted: boolean;
	logPath: string;
	errorPattern?: string;
}

export interface StartOptions {
	kind: RunKind;
	command: string;
	cwd: string;
	label?: string;
	errorPattern?: string;
}

export interface StartResult {
	record: RunRecord;
	/** Resolves when the process exits. */
	completion: Promise<RunRecord>;
	/** True when an identical (cwd, command) run was already active. */
	deduped: boolean;
}

export interface RunSummary {
	id: string;
	kind: RunKind;
	label: string;
	command: string;
	cwd: string;
	status: RunStatus;
	exitCode?: number;
	startedAt: number;
	endedAt?: number;
	durationMs: number;
}
