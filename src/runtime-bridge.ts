import type { ExtensionAPI, ExtensionContext, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BgAgentParams } from "./tools/bg-agent.ts";

type Client = { request(sessionId: string, action: string, payload: object): Promise<unknown> };
interface NodeView {
 status: string; runtimeState: string; requestDetail?: { id: string; kind: string; text: string };
 snapshot: { state: string; attempt: number; cancel: unknown };
 packet: { cwd: string; execution: { label: string; role: string; model: string; thinking: string; maxTurns: number | null; keepAlive: boolean } };
}
interface RunView { runId: string; node: NodeView | null }
const managedConfig = () => join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "pi-detach-runtime.json");
export const bridgeEnabled = () => process.env.PI_DETACH_BACKEND !== "legacy" && (Boolean(process.env.PI_DETACH_RUNTIME_BRIDGE) || existsSync(managedConfig()));
let activationFailure: string | undefined;
// A reconnected service keeps the code it started with; newer installed code is reported, never hot-swapped.
let staleRuntime = false;
// Read-only recomputation of the installed code revision for /bg_backend; never relaunches or hot-swaps.
let revisionProbe: (() => string) | undefined;
const clients = new Map<string, Promise<Client>>();
export function resetBridgeClients(): void { clients.clear(); activationFailure = undefined; staleRuntime = false; revisionProbe = undefined; }
const STALE_RUNTIME_NOTICE = "The connected runtime service runs older code than the installed pi-detach/runtime files. Start a fresh Pi session to use the update; this session keeps its existing service.";
const CLOSE_REFUSALS: Record<string, string> = {
 SHUTDOWN_ACTIVE: "a worker is still running, blocked, or cancel-pending; wait for it to settle or inspect its pane",
 SHUTDOWN_PENDING: "an admitted command is still executing; retry after it settles",
 SHUTDOWN_DELIVERY: "unacknowledged deliveries remain; let this session process them (reload if delivery stopped)",
 SHUTDOWN_BUSY: "the service is dispatching; retry in a moment",
 SHUTDOWN_CHILD_ACTIVE: "a foreman's child service still has active or unacknowledged work; let that foreman finish first",
 SHUTDOWN_CHILD_UNCERTAIN: "a foreman's child service is owned but unreachable; inspect it before closing",
};
const RECOVERY_CAUSES: Record<string, string> = {
 "effect-unproven": "the runtime could not prove the worker received its input",
 "adapter-protocol-or-bound": "the Herdr observation became ambiguous (identity drift, ambiguous prompt, or stale settlement)",
 "owner-restarted": "the runtime service restarted while this worker was active",
};
/** Actionable text for a recovery-required delivery. Never suggests resend, adoption, or kill. */
export function recoveryGuidance(delivery: { reason?: string }, handle: { id: string } | null | undefined): string {
 const cause = RECOVERY_CAUSES[delivery.reason ?? ""] ?? `of ${delivery.reason ?? "an unknown reason"}`;
 let where = "No worker pane was bound; check for an empty split pane and close it by hand.";
 try { const [paneId, agentName] = JSON.parse(handle!.id) as [string, string]; if (paneId && agentName) where = `Worker pane ${paneId} (agent ${agentName}) may still be running, or may never have received its input.`; } catch { /* unbound */ }
 return `Recovery required because ${cause}. ${where} Inspect that pane directly before deciding; the runtime will not resend, adopt, or kill it. This run ID accepts no further commands; launch a new worker for the task after inspection.`;
}
async function runtimeClient(ctx: ExtensionContext): Promise<Client> {
 if (activationFailure) throw new Error(activationFailure);
 if (process.env.PI_DETACH_RUNTIME_BRIDGE) {
  const location = process.env.PI_DETACH_RUNTIME_BRIDGE;
  const descriptor = process.env.ADVISOR_RUNTIME_DESCRIPTOR;
  if (!location.startsWith("/") || !descriptor) throw new Error("PI_DETACH_BRIDGE_CONFIGURATION");
  const module = await import(pathToFileURL(location).href);
  if (module.PI_DETACH_CLIENT_VERSION !== 1 || typeof module.createPiDetachClient !== "function") throw new Error("PI_DETACH_BRIDGE_VERSION");
  return module.createPiDetachClient(descriptor);
 }
 const sessionId = ctx.sessionManager.getSessionId();
 const key = JSON.stringify([sessionId, realpathSync(ctx.cwd), managedConfig()]);
 let pending = clients.get(key);
 if (!pending) {
  pending = (async () => {
   const config = JSON.parse(readFileSync(managedConfig(), "utf8"));
   if (config.v !== 1 || config.backend !== "runtime" || typeof config.client !== "string" || !config.client.startsWith("/") || !existsSync(config.client)) throw new Error("PI_DETACH_RUNTIME_MISSING");
   const module = await import(pathToFileURL(config.client).href);
   if (module.PI_DETACH_BOOTSTRAP_VERSION !== 1) throw new Error("PI_DETACH_BRIDGE_VERSION");
   const { detectHerdrContext } = await import("./herdr/context.ts");
   const started = await module.ensurePiDetach({ cwd: ctx.cwd, sessionId, detachPath: resolve(fileURLToPath(new URL("..", import.meta.url))), herdr: detectHerdrContext() });
   staleRuntime = started.stale === true;
   const detachPath = resolve(fileURLToPath(new URL("..", import.meta.url)));
   if (typeof module.installedRevision === "function" && typeof started.identity?.host === "string") revisionProbe = () => module.installedRevision(detachPath, started.identity.host) as string;
   return started.client as Client;
  })();
  clients.set(key, pending);
 }
 return pending;
}
async function request(ctx: ExtensionContext, action: string, payload: object): Promise<unknown> {
 const sessionId = ctx.sessionManager.getSessionId();
 if (!sessionId) throw new Error("PI_DETACH_SESSION_REQUIRED");
 return (await runtimeClient(ctx)).request(sessionId, action, payload);
}
function result<T extends object>(text: string, details: T): AgentToolResult<T> { return { content: [{ type: "text", text }], details }; }
interface BridgeAgentDetails { runId: string; agentName: string; promoted: boolean; status: string; agentState: string; durationMs: number; keepAlive: boolean; reusable: boolean }
export function assertBackend(ctx: ExtensionContext): void {
 if (bridgeEnabled()) return;
 const entries = ctx.sessionManager.getEntries?.() ?? [];
 if (entries.some(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "bg_agent" && String((entry.message.details as { runId?: string } | undefined)?.runId ?? "").startsWith("pib-"))) throw new Error("PI_DETACH_BACKEND_CHANGE_REQUIRES_NEW_ROOT");
}
export async function bridgeAgent(ctx: ExtensionContext, toolCallId: string, params: BgAgentParams, signal?: AbortSignal): Promise<AgentToolResult<BridgeAgentDetails>> {
 const accepted = await request(ctx, "call", { tool: "bg_agent", toolCallId, params, cwd: ctx.cwd }) as { runId: string; status: string };
 const format = (details: BridgeAgentDetails) => result(`Runtime agent ${details.runId}: ${details.status}. Use this exact ID for bg_output/bg_stop. BLOCKED artifact replies use name: "${details.runId}". A fresh task requires PASS/FAIL, original keepAlive, and no admitted cancellation or recovery. Busy steering is unsupported.`, details);
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
 pi.registerCommand?.("bg_backend", { description: "Show pi-detach backend readiness without launching a worker", async handler(_args, ctx) {
  if (!bridgeEnabled()) { ctx.ui.notify("pi-detach backend: legacy/unmanaged", "info"); return; }
  try {
   const state = await request(ctx, "supervision", {}) as { settled: boolean; revision?: string | null };
   // Compare the service's loaded revision against the files installed now, not the session-start snapshot.
   const stale = revisionProbe ? state.revision !== revisionProbe() : staleRuntime;
   ctx.ui.notify(`pi-detach backend: runtime connected; ${state.settled ? "no active worker work" : "worker work remains active or uncertain"}${stale ? `. ${STALE_RUNTIME_NOTICE}` : ""}`, stale ? "warning" : "info");
  }
  catch (error) { ctx.ui.notify(`pi-detach backend: runtime unavailable (${error instanceof Error ? error.message : "unknown failure"}); no legacy fallback`, "error"); }
 } });
 pi.registerCommand?.("bg_runtime_close", { description: "Close only an inactive, acknowledged runtime; never cancel workers", async handler(_args, ctx) {
  try { await request(ctx, "shutdown", {}); generation += 1; ctx.ui.notify("Runtime closed safely. Use a new Pi session for subsequent work.", "info"); }
  catch (error) { const code = error instanceof Error ? error.message : "unknown failure"; ctx.ui.notify(`Runtime close refused: ${code}${CLOSE_REFUSALS[code] ? ` (${CLOSE_REFUSALS[code]})` : ""}`, "error"); }
 } });
 pi.on("session_shutdown", () => { generation += 1; resetBridgeClients(); });
 pi.on("session_start", async (_event, ctx) => {
  if (!bridgeEnabled()) return;
  const own = ++generation;
  // A newly installed backend may not adopt agents launched by the old registry.
  const entries = ctx.sessionManager.getEntries?.() ?? [];
  const legacy = entries.some(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "bg_agent" && (() => {
   const d = entry.message.details as { runId?: string; status?: string } | undefined;
   return d?.status === "running" && d.runId && !d.runId.startsWith("pib-");
  })());
  if (legacy) activationFailure = "PI_DETACH_LEGACY_SESSION_REQUIRES_NEW_ROOT";
  try { await runtimeClient(ctx); } catch (error) { ctx.ui.notify(`pi-detach runtime unavailable: ${error instanceof Error ? error.message : "startup failed"}. bg_agent remains fenced.`, "error"); return; }
  if (staleRuntime) ctx.ui.notify(`pi-detach runtime: ${STALE_RUNTIME_NOTICE}`, "warning");
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
        let content = `${run.runId}: ${delivery.status ?? delivery.kind}. ${delivery.reason ?? ""}`;
        if (delivery.kind === "recovery-required") {
         const node = await request(ctx, "get", { runId: run.runId }) as { handle?: { id: string } | null };
         content = `${run.runId}: recovery-required. ${recoveryGuidance(delivery, node.handle)}`;
        }
        pi.sendMessage({ customType: "pi-detach-runtime", content, display: true, details: { runId: run.runId, deliveryId: delivery.id } }, ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "steer" });
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
