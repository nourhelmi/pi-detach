import type { RunRecord } from "./types.ts";

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 60) return `${minutes}m${rest.toString().padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${(minutes % 60).toString().padStart(2, "0")}m`;
}

export function outcomeLabel(record: RunRecord): string {
	if (record.status === "killed") return `killed (${record.termSignal ?? "signal"})`;
	if (record.exitCode === 0) return "exit 0";
	return `exit ${record.exitCode ?? "?"}`;
}

export function succeeded(record: RunRecord): boolean {
	return record.status === "exited" && record.exitCode === 0;
}

export function runHeadline(record: RunRecord): string {
	const duration = formatDuration((record.endedAt ?? Date.now()) - record.startedAt);
	return `${record.id} · ${record.label} — ${outcomeLabel(record)} in ${duration}`;
}
