import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatDuration, outcomeLabel } from "../format.ts";
import type { Registry } from "../registry.ts";

interface Details {
	runId: string;
	status: string;
	lines: number;
}

export function registerBgOutputTool(pi: ExtensionAPI, registry: Registry): void {
	pi.registerTool({
		name: "bg_output",
		label: "Detach: Output",
		description:
			"Read the captured output of a run started by bg_run or bg_watch. " +
			"Returns the last `lines` lines, optionally filtered by a case-insensitive regex.",
		promptSnippet: "bg_output — read the log of a background run on demand.",
		promptGuidelines: [
			"Call bg_output when you need more than the tail you were shown, or to inspect a running watch. Never call it in a polling loop to wait for completion.",
		],
		parameters: Type.Object({
			runId: Type.String({ description: "Run id returned by bg_run or bg_watch." }),
			lines: Type.Optional(
				Type.Number({ description: "How many trailing lines to return. Defaults to 100." }),
			),
			grep: Type.Optional(
				Type.String({ description: "Case-insensitive regex; only matching lines are returned." }),
			),
		}),
		executionMode: "parallel",

		async execute(_toolCallId, params): Promise<AgentToolResult<Details>> {
			const record = registry.get(params.runId);
			if (!record) {
				return {
					content: [{ type: "text", text: `No run with id ${params.runId}.` }],
					details: { runId: params.runId, status: "unknown", lines: 0 },
				};
			}
			const output = await registry.readLog(params.runId, {
				lines: params.lines ?? 100,
				...(params.grep ? { grep: params.grep } : {}),
			});
			const duration = formatDuration((record.endedAt ?? Date.now()) - record.startedAt);
			const state =
				record.status === "running"
					? `running for ${duration}`
					: `${outcomeLabel(record)} after ${duration}`;
			const header = `${record.id} · ${record.label} — ${state}`;
			return {
				content: [
					{ type: "text", text: output.trim() ? `${header}\n\n${output.trimEnd()}` : `${header}\n\n(no output)` },
				],
				details: {
					runId: record.id,
					status: record.status,
					lines: output ? output.split("\n").length : 0,
				},
			};
		},

		renderCall(args) {
			return new Text(`output ${args.runId}`, 0, 0);
		},

		renderResult(result) {
			const details = result.details as Details | undefined;
			return new Text(details ? `${details.lines} lines` : "", 0, 0);
		},
	});
}
