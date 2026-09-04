import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RunRecord } from "./types.ts";

export type RunTransportState = "running" | "paused" | "finished";

export interface RunLifecycleRevision {
	revision: number;
	transportState: RunTransportState;
}

export interface RunStateSnapshot {
	version: 1;
	runId: string;
	kind: RunRecord["kind"];
	backend: RunRecord["backend"];
	label: string;
	cwd: string;
	status: RunRecord["status"];
	surface?: RunRecord["surface"];
	logPath: string;
	resultPath?: string;
	resultStatus?: string;
	agentState?: RunRecord["agentState"];
	transportState: RunTransportState;
	lifecycleRevision: number;
	settlementDecision: "wait" | "pause" | "finish";
	settlementGeneration?: string;
	startedAt: number;
	updatedAt: number;
	endedAt?: number;
}

export function defaultRunStatePath(runId: string): string {
	const root = process.env.PI_DETACH_STATE_ROOT ?? join(homedir(), ".pi", "detach");
	return join(root, "runs", runId, "state.json");
}

export async function writeRunState(
	record: RunRecord,
	lifecycle: RunLifecycleRevision,
	path = defaultRunStatePath(record.id),
): Promise<void> {
	if (!Number.isSafeInteger(lifecycle.revision) || lifecycle.revision < 0) {
		throw new Error("run lifecycle revision must be a non-negative safe integer");
	}
	const snapshot: RunStateSnapshot = {
		version: 1,
		runId: record.id,
		kind: record.kind,
		backend: record.backend,
		label: record.label,
		cwd: record.cwd,
		status: record.status,
		...(record.surface ? { surface: record.surface } : {}),
		logPath: record.logPath,
		...(record.resultPath ? { resultPath: record.resultPath } : {}),
		...(record.resultStatus ? { resultStatus: record.resultStatus } : {}),
		...(record.agentState ? { agentState: record.agentState } : {}),
		transportState: lifecycle.transportState,
		lifecycleRevision: lifecycle.revision,
		settlementDecision: lifecycle.transportState === "paused" ? "pause" : lifecycle.transportState === "finished" ? "finish" : "wait",
		...(record.settlementGeneration ? { settlementGeneration: record.settlementGeneration } : {}),
		startedAt: record.startedAt,
		updatedAt: Date.now(),
		...(record.endedAt ? { endedAt: record.endedAt } : {}),
	};
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, path);
}

export type RunStateWriter = typeof writeRunState;
