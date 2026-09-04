import { readSettlementArtifact, decideAgentSettlement } from "../agent-settlement.ts";
import type { DriverStart, PiLaunchSpec } from "../types.ts";
import { BbClientError, type BbClient } from "./client.ts";
import type { BbContext } from "./context.ts";

export interface BbDriverOptions {
	client: BbClient;
	context: BbContext;
	hostId: string;
	reconnectDelayMs?: number;
	startAttempts?: number;
}

function exactLaunch(options: { piLaunchSpec?: PiLaunchSpec }): PiLaunchSpec {
	const launch = options.piLaunchSpec;
	if (!launch) throw new Error("BB bg_agent requires a structured Pi launch spec");
	return launch;
}

function retryableTransport(error: unknown): boolean {
	return error instanceof BbClientError && (
		error.code === "network" ||
		(error.code === "http" && [404, 500, 502, 503, 504].includes(error.status ?? 0))
	);
}

function waitDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
	if (milliseconds <= 0 || signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(done, milliseconds);
		function done(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

export function createBbDriver({
	client,
	context,
	hostId,
	reconnectDelayMs = 250,
	startAttempts = 8,
}: BbDriverOptions): DriverStart {
	return async (options, controller) => {
		if (options.kind !== "agent") throw new Error("BB driver accepts agent runs only");
		const launch = exactLaunch(options);
		const resultPath = options.requiredArtifactPath ?? launch.resultPath;
		if (!resultPath) throw new Error("BB agent launch requires a reserved result artifact");
		const reasoning = launch.reasoning === "off" ? "none" : launch.reasoning;
		const startRequest = {
			version: "1",
			runId: controller.record.id,
			logicalParentThreadId: context.threadId,
			projectId: context.projectId,
			environmentId: context.environmentId,
			hostId,
			cwd: options.cwd,
			label: options.label ?? controller.record.label,
			prompt: launch.prompt,
			providerId: "pi",
			model: `${launch.provider}/${launch.model}`,
			reasoning,
			resultPath,
			bootstrap: { role: launch.role, maxTurns: launch.maxTurns, allowSubagents: launch.allowSubagents },
		} as const;
		let started: Awaited<ReturnType<BbClient["start"]>>;
		for (let attempt = 1; ; attempt += 1) {
			try {
				started = await client.start(startRequest);
				break;
			} catch (error) {
				if (!retryableTransport(error) || attempt >= startAttempts) throw error;
				if (attempt === 1) controller.progress?.("BB start response disconnected; retrying the idempotent run ID");
				await waitDelay(Math.min(reconnectDelayMs * 2 ** (attempt - 1), 5_000));
			}
		}
		const expected = { projectId: context.projectId, hostId, cwd: options.cwd, model: `${launch.provider}/${launch.model}`, reasoning };
		for (const [key, value] of Object.entries(expected)) {
			if (started[key as keyof typeof started] !== value) throw new Error(`BB launch identity mismatch: ${key}`);
		}
		controller.record.surface = { kind: "bb", threadId: started.threadId, logicalParentThreadId: context.threadId, hostId };
		let stopped = false;
		let waiting: AbortController | undefined;
		let resumed: { promise: Promise<void>; resolve: () => void } | undefined;
		const supervise = async (): Promise<void> => {
			let until: "idle" | "active" = "idle";
			let reconnectAttempt = 0;
			while (!stopped) {
				waiting = new AbortController();
				let observed;
				try {
					observed = await client.wait({ version: "1", runId: controller.record.id, threadId: started.threadId, until }, waiting.signal);
					reconnectAttempt = 0;
				} catch (error) {
					if (stopped) return;
					if (!retryableTransport(error)) throw error;
					reconnectAttempt += 1;
					if (reconnectAttempt === 1) controller.progress?.("BB threads.wait disconnected; re-arming the same event-driven wait");
					await waitDelay(Math.min(reconnectDelayMs * 2 ** (reconnectAttempt - 1), 5_000), waiting.signal);
					continue;
				}
				if (stopped) return;
				if (until === "active") {
					await controller.resume();
					resumed?.resolve();
					resumed = undefined;
					until = "idle";
					continue;
				}
				const artifact = await readSettlementArtifact(resultPath, controller.record.startedAt);
				const decision = decideAgentSettlement({ transportState: observed.transportState, artifact, logicalDescendants: observed.logicalDescendants });
				if (decision.kind === "finish") {
					controller.finish({ agentState: decision.agentState, resultStatus: decision.resultStatus, settlementGeneration: decision.generation, ...(decision.agentState === "done" || decision.agentState === "idle" ? { exitCode: 0 } : {}) });
					return;
				}
				if (decision.kind === "pause") {
					let resolveResume!: () => void;
					const promise = new Promise<void>((resolve) => { resolveResume = resolve; });
					resumed = { promise, resolve: resolveResume };
					controller.pause({ agentState: "blocked", resultStatus: decision.resultStatus, settlementGeneration: decision.generation, note: "result artifact reports BLOCKED" });
					until = "active";
					continue;
				}
				controller.progress?.(decision.reason);
				until = "active";
			}
		};
		void supervise().catch((error) => {
			if (!stopped) controller.finish({ agentState: "stalled", note: error instanceof Error ? error.message : String(error) });
		});
		return {
			agentName: options.label,
			surface: controller.record.surface,
			async continue(prompt) {
					if (controller.record.agentState !== "blocked") throw new Error("BB agent is not paused BLOCKED");
					if (prompt !== "BB-POC-CONTINUE") throw new Error("BB BLOCKED continuation must equal BB-POC-CONTINUE");
				const observed = resumed;
				if (!observed) throw new Error("BB agent has no pending resume transition");
				await client.start({ version: "1", runId: controller.record.id, logicalParentThreadId: context.threadId, projectId: context.projectId, environmentId: context.environmentId, hostId, cwd: options.cwd, label: controller.record.label, prompt, providerId: "pi", model: `${launch.provider}/${launch.model}`, reasoning, resultPath, bootstrap: { role: launch.role, maxTurns: launch.maxTurns, allowSubagents: launch.allowSubagents }, continuation: true });
				await observed.promise;
			},
			stop() {
				stopped = true;
				waiting?.abort();
				void client.stop({ version: "1", runId: controller.record.id, threadId: started.threadId })
					.then(
						() => controller.finish({ killed: true, agentState: "unknown" }),
						(error) => controller.finish({ killed: true, agentState: "unknown", note: `BB stop outcome unknown: ${error instanceof Error ? error.message : String(error)}` }),
					);
			},
		};
	};
}
