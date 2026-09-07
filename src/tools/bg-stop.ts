import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Registry } from "../registry.ts";

import { bridgeEnabled, bridgeStop } from "../runtime-bridge.ts";

interface Details {
	runId: string;
	stopped: boolean;
    status?: string;
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

		async execute(_toolCallId, params, _signal, _update, ctx): Promise<AgentToolResult<Details>> {
			if (bridgeEnabled() && (!registry.get(params.runId) || registry.get(params.runId)?.kind === "agent")) return bridgeStop(ctx, _toolCallId, params.runId);
            const record = registry.stop(params.runId);
			if (!record) {
				return {
					content: [{ type: "text", text: `No run with id ${params.runId}.` }],
					details: { runId: params.runId, stopped: false },
				};
			}
			const how =
				record.backend === "herdr"
					? record.kind === "agent"
						? `Sent esc to agent ${record.agentName} in pane ${record.paneId}; the agent stays alive there.`
						: `Sent ctrl+c to pane ${record.paneId}; the pane stays open with its output.`
					: `Sent SIGTERM to ${record.id} · ${record.label}.`;
			return {
				content: [{ type: "text", text: how }],
				details: { runId: record.id, stopped: true },
			};
		},

		renderCall(args) {
			return new Text(`stop ${args.runId}`, 0, 0);
		},

		renderResult(result) {
			const details = result.details as Details | undefined;
			if (details?.status === "cancel-pending") return new Text("cancel pending; exit unconfirmed", 0, 0);
            return new Text(details?.stopped ? `stopped ${details.runId}` : "not found", 0, 0);
		},
	});
}
