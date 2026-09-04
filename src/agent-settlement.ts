import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { AgentSettledState } from "./types.ts";

export const REQUIRED_ARTIFACT_HEADINGS = [
	"Status",
	"Claims",
	"Evidence",
	"Files",
	"Decisions",
	"Remaining Risk",
] as const;

/**
 * Return one markdown section through the next heading at the same or a
 * shallower level. Child subsections therefore count as part of their required
 * parent section instead of accidentally making that parent look empty.
 */
function artifactSection(content: string, heading: string): string | undefined {
	const match = new RegExp(`^(#{1,6})\\s+${heading}\\s*$`, "im").exec(content);
	if (!match) return undefined;
	const level = match[1]?.length ?? 1;
	const remainder = content.slice(match.index + match[0].length);
	const closer = new RegExp(`^#{1,${level}}\\s+\\S.*$`, "m");
	const nextHeading = remainder.search(closer);
	return nextHeading >= 0 ? remainder.slice(0, nextHeading) : remainder;
}

function artifactContentIssue(path: string, content: string): string | undefined {
	if (!content.trim()) return `empty ${path}`;
	const missing: string[] = [];
	const empty: string[] = [];
	for (const heading of REQUIRED_ARTIFACT_HEADINGS) {
		const body = artifactSection(content, heading);
		if (body === undefined) {
			missing.push(heading);
			continue;
		}
		const prose = body
			.split("\n")
			.filter((line) => !/^#{1,6}\s/.test(line.trim()))
			.join("\n")
			.trim();
		if (!prose) empty.push(heading);
	}
	if (missing.length) return `${path} is missing headings: ${missing.join(", ")}`;
	return empty.length ? `${path} has empty sections: ${empty.join(", ")}` : undefined;
}

async function readArtifactSnapshot(
	path: string,
	notBefore?: number,
): Promise<{ content?: string; issue?: string }> {
	try {
		const metadata = await stat(path);
		if (notBefore !== undefined && metadata.mtimeMs < notBefore) {
			return { issue: `stale ${path}` };
		}
		const content = await readFile(path, "utf8");
		const issue = artifactContentIssue(path, content);
		return { content, ...(issue ? { issue } : {}) };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return { issue: code === "ENOENT" ? `missing ${path}` : `could not read ${path}: ${(error as Error).message}` };
	}
}

export async function settlementArtifactIssue(
	path: string,
	options: { notBefore?: number } = {},
): Promise<string | undefined> {
	return (await readArtifactSnapshot(path, options.notBefore)).issue;
}

export type ResultStatusClassification = "blocked" | "in-progress" | "terminal";
export interface ResultArtifactStatus {
	line: string;
	classification: ResultStatusClassification;
}

export function parseResultArtifactStatus(content: string): ResultArtifactStatus | undefined {
	const body = artifactSection(content, "Status");
	if (body === undefined) return undefined;
	const rawLine = body
		.split("\n")
		.find((line) => line.trim() && !/^#{1,6}\s/.test(line.trim()));
	if (!rawLine) return undefined;
	const line = rawLine.trim().replace(/^[*_`]+/, "").replace(/^Status\s*:\s*/i, "").replace(/[.!?,;:]+$/, "")
		.replace(/[*_`]+$/, "").replace(/[.!?,;:]+$/, "").trim().slice(0, 200);
	const classification = /^BLOCKED\b/i.test(line)
		? "blocked"
		: /^(?:IN[ _-]PROGRESS|WORKING|WAITING|PAUSED|RUNNING)\b/i.test(line)
			? "in-progress"
			: "terminal";
	return { line, classification };
}

export type TransportState = "active" | "idle" | "error" | "stopped";
export type LogicalDescendants = "none" | "live" | "indeterminate";
export type SettlementDecision =
	| { kind: "wait"; reason: string }
	| { kind: "pause"; agentState: "blocked"; resultStatus: string; generation: string }
	| { kind: "finish"; agentState: AgentSettledState; resultStatus: string; generation: string };

function generation(input: object): string {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function decideAgentSettlement(input: {
	transportState: TransportState;
	artifact?: { issue?: string; status?: ResultArtifactStatus; fingerprint?: string };
	logicalDescendants: LogicalDescendants;
}): SettlementDecision {
	if (input.transportState === "active") return { kind: "wait", reason: "transport is active" };
	if (input.transportState === "error" || input.transportState === "stopped") {
		return { kind: "finish", agentState: "stalled", resultStatus: input.artifact?.status?.line ?? "transport failed", generation: generation(input) };
	}
	if (input.artifact?.issue) return { kind: "finish", agentState: "stalled", resultStatus: input.artifact.issue, generation: generation(input) };
	const status = input.artifact?.status;
	if (!status) return { kind: "finish", agentState: "stalled", resultStatus: "result artifact has no parseable Status", generation: generation(input) };
	if (status.classification === "blocked") {
		return { kind: "pause", agentState: "blocked", resultStatus: status.line, generation: generation(input) };
	}
	if (status.classification === "in-progress") {
		return input.logicalDescendants === "live"
			? { kind: "wait", reason: `result Status is still "${status.line}" with live descendants` }
			: { kind: "finish", agentState: "stalled", resultStatus: status.line, generation: generation(input) };
	}
	if (input.logicalDescendants !== "none") {
		return { kind: "wait", reason: input.logicalDescendants === "live" ? "logical descendants are live" : "logical descendants are indeterminate" };
	}
	return { kind: "finish", agentState: "done", resultStatus: status.line, generation: generation(input) };
}

export async function readSettlementArtifact(path: string, notBefore?: number): Promise<{
	issue?: string;
	status?: ResultArtifactStatus;
	fingerprint: string;
}> {
	const snapshot = await readArtifactSnapshot(path, notBefore);
	const issue = snapshot.issue;
	if (issue) return { issue, fingerprint: createHash("sha256").update(`${path}\0${issue}`).digest("hex") };
	const content = snapshot.content;
	if (content === undefined) throw new Error("validated artifact snapshot has no content");
	const fingerprint = createHash("sha256").update(`${path}\0${content}`).digest("hex");
	const status = parseResultArtifactStatus(content);
	return status ? { status, fingerprint } : { issue: `unparseable Status in ${path}`, fingerprint };
}
