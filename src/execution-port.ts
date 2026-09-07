/** Service-owned execution port. Public tool arguments never supply these hooks. */
import { Value } from "typebox/value";
import { BgAgentParameters, agentLabel, prepareLaunch, type BgAgentParams } from "./tools/bg-agent.ts";
import { createHerdrDriver, type HerdrDriverDeps } from "./herdr/driver.ts";
import type { DriverHandle, RuntimeExecutionHooks } from "./types.ts";

export const PI_DETACH_EXECUTION_VERSION = 1;
export interface AgentExecutionIntent {
 v: 1;
 command: string;
 prompt: string;
 role: string;
 runtime: string;
 model: string;
 thinking: string;
 maxTurns: number | null;
 requiredSkills: string[];
 harness: string;
 keepAlive: boolean;
 label: string;
 resultDiscovery: string | null;
 resultPolicy: "runtime-capture";
 sourceDirectory: string;
 environment: Record<string, string>;
}
export interface AgentExecutionPort {
 version: 1;
 prepare(params: unknown, sourceDirectory: string): Promise<AgentExecutionIntent>;
 launch(input: { id: string; cwd: string; intent: AgentExecutionIntent; hooks: Omit<RuntimeExecutionHooks, "environment">; reply?: string }): Promise<DriverHandle>;
}
export function createAgentExecutionPort(deps: HerdrDriverDeps): AgentExecutionPort {
 const driver = createHerdrDriver(deps);
 const executionEnvironment = (sourceDirectory: string) => {
  const environment = Object.fromEntries(Object.entries(deps.env ?? process.env).filter(([key, value]) => ["PATH", "PI_CODING_AGENT_DIR", "PI_DETACH_AGENT_PROFILES", "CODEX_HOME"].includes(key) && typeof value === "string")) as Record<string, string>;
  return { ...environment, ADVISOR_RUNTIME_DESCRIPTOR: "", PI_DETACH_RUNTIME_BRIDGE: "", ADVISOR_BRIDGE_WORKER_DIR: sourceDirectory, ADVISOR_RUNTIME_CANONICAL_OWNER: "1" };
 };
 return {
  version: 1,
  async prepare(input, sourceDirectory) {
   if (!Value.Check(BgAgentParameters, input) || !input || typeof input !== "object" || Object.keys(input).some(key => !Object.hasOwn(BgAgentParameters.properties, key))) throw new Error("BRIDGE_INVALID_INPUT");
   const params = input as BgAgentParams;
   if (params.resultPath !== undefined) throw new Error("BRIDGE_CUSTOM_ARTIFACT_UNSUPPORTED");
   if (params.agent !== undefined) throw new Error("BRIDGE_EXPLICIT_COMMAND_UNSUPPORTED");
   if (params.name !== undefined) throw new Error("BRIDGE_FOLLOWUP_REQUIRES_BINDING");
   if (!params.prompt.trim()) throw new Error("BRIDGE_EMPTY_PROMPT");
   const requiredSkills = params.requiredSkills ?? [];
   if (requiredSkills.some(skill => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill))) throw new Error("BRIDGE_INVALID_SKILL");
   const label = agentLabel(params);
   const launch = await prepareLaunch({ ...params, resultPath: `${sourceDirectory}/result.md` }, label);
   return {
    v: 1, command: launch.command,
    prompt: launch.prompt + (!launch.role ? `${requiredSkills.length ? "\nREQUIRED SKILLS:\nLoad and follow: " + requiredSkills.join(", ") : ""}${params.maxTurns ? "\nTURN CAP: " + params.maxTurns : ""}` : "") + `\n\nRESULT ARTIFACT:\nWrite the bounded result to ${sourceDirectory}/result.md. Include Status, Claims, Evidence, Files, Decisions, Remaining Risk.`,
    role: launch.role ?? "worker", runtime: launch.runtime,
    model: params.model ?? "default", thinking: launch.thinking ?? "default",
    maxTurns: launch.maxTurns ?? params.maxTurns ?? null,
    requiredSkills: params.requiredSkills ?? [], harness: launch.runtime.split("/").pop() === "pi" ? "pi" : "native",
    keepAlive: params.keepAlive ?? false, label, resultDiscovery: launch.resultDiscovery ?? null,
    resultPolicy: "runtime-capture", sourceDirectory, environment: executionEnvironment(sourceDirectory),
   };
  },
  async launch({ id, cwd, intent, hooks, reply }) {
   return driver({ kind: "agent", command: intent.command, cwd, label: intent.label, prompt: reply ?? intent.prompt, closeOnSettle: !intent.keepAlive, runtimeExecution: { ...hooks, environment: intent.environment } }, {
    record: { id, kind: "agent", command: intent.command, cwd, label: intent.label, status: "running", backend: "herdr", startedAt: Date.now(), promoted: false, logPath: "" },
    emitOutput() {}, finish() { throw new Error("BRIDGE_LEGACY_SETTLEMENT_FORBIDDEN"); },
   });
  },
 };
}
