import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { formatDuration, outcomeLabel } from "../format.ts";
import type { Registry } from "../registry.ts";

import { bridgeEnabled, bridgeOutput } from "../runtime-bridge.ts";

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
			"Read output from bg_run, bg_watch, or a managed bg_agent. Terminal mode returns a tail with optional regex filtering. " +
			"Transcript mode searches recorded session history with literal case-insensitive matching, context, and pagination.",
		promptSnippet: "bg_output — read the log of a background run on demand.",
		promptGuidelines: [
			"Call bg_output when you need more than the tail you were shown, or to inspect a running watch. Never call it in a polling loop to wait for completion.",
		],
		parameters: Type.Object({
            source: Type.Optional(StringEnum(["terminal", "transcript"] as const, { description: "Managed agent: read recorded session history or terminal tail (default). Transcript grep is a literal case-insensitive search over all records." })),
            entryRef: Type.Optional(Type.String({ description: "Stable transcript record reference for reading full recorded JSON in byte pages." })),
            offset: Type.Optional(Type.Integer({ minimum: 0 })),
            maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 65536 })),
            cursor: Type.Optional(Type.Integer({ minimum: 0 })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
            context: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
			runId: Type.String({ description: "Run id returned by bg_run, bg_watch, or managed bg_agent." }),
			lines: Type.Optional(
				Type.Number({ description: "How many trailing lines to return. Defaults to 100." }),
			),
			grep: Type.Optional(
				Type.String({ description: "Terminal: case-insensitive regex. Transcript: literal case-insensitive search across the recorded history." }),
			),
		}),
		executionMode: "parallel",

		async execute(_toolCallId, params, _signal, _update, ctx): Promise<AgentToolResult<Details>> {
			if (bridgeEnabled() && params.runId.startsWith("pib-") && !registry.get(params.runId)) return bridgeOutput(ctx, params.runId, params);
            if (params.source === "transcript") return { content: [{ type: "text", text: "Transcript source unavailable for this unmanaged run; terminal output is not a transcript." }], details: { runId: params.runId, status: "unavailable", lines: 0 } };
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
