import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatDuration } from "../format.ts";
import type { Registry } from "../registry.ts";
import type { RunSummary } from "../types.ts";

interface Details {
	runs: RunSummary[];
}

export function registerBgListTool(pi: ExtensionAPI, registry: Registry): void {
	pi.registerTool({
		name: "bg_list",
		label: "Detach: List",
		description:
			"List background runs from this session — id, kind, status, directory, and duration. " +
			"Takes no parameters.",
		promptSnippet: "bg_list — see which background runs and watches are active.",
		parameters: Type.Object({}),
		executionMode: "parallel",

		async execute(): Promise<AgentToolResult<Details>> {
			const runs = registry.list();
			const text =
				runs.length === 0
					? "No background runs."
					: runs
							.map((run) => {
								const state =
									run.status === "running"
										? `running ${formatDuration(run.durationMs)}`
										: `${run.status}${run.exitCode !== undefined ? ` ${run.exitCode}` : ""} after ${formatDuration(run.durationMs)}`;
								return `${run.id} · ${run.kind} · ${state} · ${run.label} · ${run.cwd}`;
							})
							.join("\n");
			return { content: [{ type: "text", text }], details: { runs } };
		},

		renderCall() {
			return new Text("bg_list", 0, 0);
		},

		renderResult(result) {
			const details = result.details as Details | undefined;
			if (!details || details.runs.length === 0) return new Text("No background runs.", 0, 0);
			const running = details.runs.filter((run) => run.status === "running").length;
			return new Text(`${details.runs.length} runs · ${running} active`, 0, 0);
		},
	});
}
