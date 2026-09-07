import type { ExtensionAPI, ExtensionContext, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { pathToFileURL } from "node:url";
import type { BgAgentParams } from "./tools/bg-agent.ts";

type Client = { request(sessionId: string, action: string, payload: object): Promise<unknown> };
interface NodeView {
 status: string; runtimeState: string; requestDetail?: { id: string; kind: string; text: string };
 snapshot: { state: string; attempt: number; cancel: unknown };
 packet: { execution: { label: string; role: string; model: string; thinking: string; maxTurns: number | null; keepAlive: boolean } };
}
interface RunView { runId: string; node: NodeView | null }
export const bridgeEnabled = () => Boolean(process.env.PI_DETACH_RUNTIME_BRIDGE);
async function request(ctx: ExtensionContext, action: string, payload: object): Promise<unknown> {
 const location = process.env.PI_DETACH_RUNTIME_BRIDGE;
 const descriptor = process.env.ADVISOR_RUNTIME_DESCRIPTOR;
 if (!location?.startsWith("/") || !descriptor) throw new Error("PI_DETACH_BRIDGE_CONFIGURATION");
 const module = await import(pathToFileURL(location).href) as { PI_DETACH_CLIENT_VERSION?: number; createPiDetachClient?: (path: string) => Client };
 if (module.PI_DETACH_CLIENT_VERSION !== 1 || typeof module.createPiDetachClient !== "function") throw new Error("PI_DETACH_BRIDGE_VERSION");
 const sessionId = ctx.sessionManager.getSessionId();
 if (!sessionId) throw new Error("PI_DETACH_SESSION_REQUIRED");
 return module.createPiDetachClient(descriptor).request(sessionId, action, payload);
}
function result<T extends object>(text: string, details: T): AgentToolResult<T> { return { content: [{ type: "text", text }], details }; }
interface BridgeAgentDetails { runId: string; agentName: string; promoted: boolean; status: string; agentState: string; durationMs: number }
export async function bridgeAgent(ctx: ExtensionContext, toolCallId: string, params: BgAgentParams, signal?: AbortSignal): Promise<AgentToolResult<BridgeAgentDetails>> {
 const accepted = await request(ctx, "call", { tool: "bg_agent", toolCallId, params, cwd: ctx.cwd }) as { runId: string; status: string };
 const format = (details: BridgeAgentDetails) => result(`Runtime agent ${details.runId}: ${details.status}. Use this exact ID for bg_output/bg_stop. BLOCKED artifact replies use name: "${details.runId}". Busy steer and terminal resume are unsupported.`, details);
 const prior = await request(ctx, "result", { toolCallId, seal: false }) as BridgeAgentDetails | null;
 if (prior) return format(prior);
 const deadline = Date.now() + Math.max(0, params.promoteAfterMs ?? 30000);
 do {
  const node = await request(ctx, "get", { runId: accepted.runId }) as NodeView;
  if (node.snapshot.state !== "running" || node.runtimeState === "recovery-required" || signal?.aborted || Date.now() >= deadline) break;
  await request(ctx, "wait", { runId: accepted.runId });
 } while (Date.now() < deadline);
 return format(await request(ctx, "result", { toolCallId, seal: true }) as BridgeAgentDetails);
}
export async function bridgeStop(ctx: ExtensionContext, toolCallId: string, runId: string): Promise<AgentToolResult<{ runId: string; stopped: boolean; status: string }>> {
 await request(ctx, "call", { tool: "bg_stop", toolCallId, params: { runId }, cwd: ctx.cwd });
 return result(`Cancellation admitted for ${runId}. Escape is pending or sent; terminal cancellation and process exit are unconfirmed.`, { runId, stopped: false, status: "cancel-pending" });
}
export async function bridgeList(ctx: ExtensionContext): Promise<RunView[]> { return await request(ctx, "list", {}) as RunView[]; }
export async function bridgeOutput(ctx: ExtensionContext, runId: string, options: { lines?: number; grep?: string } = {}): Promise<AgentToolResult<{ runId: string; status: string; lines: number }>> {
 const node = await request(ctx, "get", { runId }) as NodeView;
 const output = await request(ctx, "output", { runId }) as { text: string };
 let lines = output.text.split("\n");
 if (options.grep) {
  const pattern = options.grep;
  try { const re = new RegExp(pattern, "i"); lines = lines.filter(line => re.test(line)); }
  catch { lines = lines.filter(line => line.toLowerCase().includes(pattern.toLowerCase())); }
 }
 lines = lines.slice(-Math.max(1, Math.min(options.lines ?? 100, 2000)));
 return result(`${runId}: ${node.status}\n${lines.join("\n")}`, { runId, status: node.status, lines: lines.length });
}
/** Reconnecting delivery consumer only. No execution ownership lives in Pi. */
export function registerBridgeDelivery(pi: ExtensionAPI): void {
 let generation = 0;
 pi.on("session_shutdown", () => { generation += 1; });
 pi.on("session_start", (_event, ctx) => {
  if (!bridgeEnabled()) return;
  const own = ++generation;
  void (async () => {
   try {
    while (own === generation) {
     const runs = await bridgeList(ctx);
     for (const run of runs) {
      if (own !== generation) return;
      if (!run.node) continue;
      const deliveries = await request(ctx, "wait", { runId: run.runId, timeoutMs: 0 }) as Array<{ id: number; kind: string; status?: string; reason?: string }>;
      for (const delivery of deliveries) {
       if (own !== generation) return;
       if (["settled", "recovery-required"].includes(delivery.kind)) {
        pi.sendMessage({ customType: "pi-detach-runtime", content: `${run.runId}: ${delivery.status ?? delivery.kind}. ${delivery.reason ?? ""}`, display: true, details: { runId: run.runId, deliveryId: delivery.id } }, ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "steer" });
       }
       if (own !== generation) return;
       await request(ctx, "ack", { runId: run.runId, deliveryId: delivery.id });
      }
     }
     await new Promise(resolve => setTimeout(resolve, 250));
    }
   } catch { if (own === generation) ctx.ui.notify("pi-detach runtime delivery disconnected; reload after restoring the service. Unacked deliveries are retained.", "error"); }
  })();
 });
}
