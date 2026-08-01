import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Registry } from "../registry.ts";

interface Details {
	runId: string;
	stopped: boolean;
}

export function registerBgStopTool(pi: ExtensionAPI, registry: Registry): void {
	pi.registerTool({
		name: "bg_stop",
		label: "Detach: Stop",
		description:
			"Terminate a background run and its child processes. Use it to shut down a " +
			"bg_watch process such as a dev server, or to cancel a promoted bg_run.",
		promptSnippet: "bg_stop — terminate a background run or watch.",
		parameters: Type.Object({
			runId: Type.String({ description: "Run id returned by bg_run or bg_watch." }),
		}),
		executionMode: "parallel",

		async execute(_toolCallId, params): Promise<AgentToolResult<Details>> {
			const record = registry.stop(params.runId);
			if (!record) {
				return {
					content: [{ type: "text", text: `No run with id ${params.runId}.` }],
					details: { runId: params.runId, stopped: false },
				};
			}
			return {
				content: [{ type: "text", text: `Sent SIGTERM to ${record.id} · ${record.label}.` }],
				details: { runId: record.id, stopped: true },
			};
		},

		renderCall(args) {
			return new Text(`stop ${args.runId}`, 0, 0);
		},

		renderResult(result) {
			const details = result.details as Details | undefined;
			return new Text(details?.stopped ? `stopped ${details.runId}` : "not found", 0, 0);
		},
	});
}
