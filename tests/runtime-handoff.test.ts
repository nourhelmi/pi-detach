import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bridgeAgent, formatHandoff, registerBridgeDelivery, resetBridgeClients } from "../src/runtime-bridge.ts";
import { registerBgListTool } from "../src/tools/bg-list.ts";
import type { Registry } from "../src/registry.ts";

for (const status of ['PASS', 'FAIL', 'BLOCKED', 'unknown', 'missing']) test(`public managed handoffs ${status}: launch, list, delivery and reload expose captured report`, async t => {
  const dir = await mkdtemp('/tmp/detach-handoff-'); const path = join(dir, 'result-1-hash.md');
  await writeFile(path, `# Status\n${status}\n`);
  const result = status === 'missing' ? null : { path, sha256: 'a'.repeat(64), attempt: 1, status, claims: 'Exact claim', evidence: 'Actual report evidence', risks: 'Known limitation', integrity: 'intact', proof: 'unknown', tested: null, limitation: 'Captured worker report, not independent verification.' };
  const handoff = { runId: 'pib-fixture', agentName: 'pib-fixture', promoted: false, agentState: 'done', durationMs: 0, keepAlive: true, status: status === 'BLOCKED' ? 'blocked' : status === 'FAIL' ? 'failed' : status === 'missing' ? 'stalled' : 'done', attempt: 1, continuation: status === 'BLOCKED' ? 'reply' : ['PASS', 'FAIL'].includes(status) ? 'task' : 'none', reusable: ['PASS', 'FAIL'].includes(status), result };
  const node = { ...handoff, runtimeState: 'active', snapshot: { state: 'terminal', cancel: null }, packet: { cwd: dir, execution: { label: 'fixture' } } };
  const modulePath = join(dir, 'client.mjs'); await writeFile(modulePath, `export const PI_DETACH_CLIENT_VERSION = 1;\nconst handoff = ${JSON.stringify(handoff)}, node = ${JSON.stringify(node)};\nexport function createPiDetachClient() { return { async request(session, action, payload) { if (session !== 'owner') throw Error('wrong owner'); if (action === 'call' || action === 'result') return handoff; if (action === 'get') return node; if (action === 'list') return [{runId: handoff.runId, node}]; if (action === 'wait') return [{id: 1, kind: 'settled', status: handoff.status, reason: 'fixture captured', attempt: 1, result: handoff.result ? {...handoff.result, integrity: 'invalid'} : null, handoff}]; if (action === 'ack') return {}; throw Error(action); } }; }`);
  const previous = { bridge: process.env.PI_DETACH_RUNTIME_BRIDGE, descriptor: process.env.ADVISOR_RUNTIME_DESCRIPTOR, backend: process.env.PI_DETACH_BACKEND };
  process.env.PI_DETACH_RUNTIME_BRIDGE = modulePath; process.env.ADVISOR_RUNTIME_DESCRIPTOR = join(dir, 'descriptor'); delete process.env.PI_DETACH_BACKEND;
  t.after(async () => { for (const [key, value] of Object.entries({ PI_DETACH_RUNTIME_BRIDGE: previous.bridge, ADVISOR_RUNTIME_DESCRIPTOR: previous.descriptor, PI_DETACH_BACKEND: previous.backend })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } resetBridgeClients(); await rm(dir, { recursive: true, force: true }); });
  const ctx = { cwd: dir, sessionManager: { getSessionId: () => 'owner', getEntries: () => [] }, isIdle: () => true, ui: { notify() {} } } as unknown as ExtensionContext;
  const launched = await bridgeAgent(ctx, 'first', { prompt: 'task', promoteAfterMs: 0 });
  const expect = (text: string) => { assert.match(text, /Current status:/); if (result) { assert.ok(text.includes(path)); assert.ok(text.includes('Exact claim')); assert.match(text, /proof: unknown/); assert.match(text, /Tested: unknown/); } else assert.match(text, /No current captured result/); };
  expect((launched.content[0] as { text: string }).text);
  if (result) assert.equal(await readFile(launched.details.result!.path, 'utf8'), `# Status\n${status}\n`);
  let listTool: any; registerBgListTool({ registerTool(tool: any) { listTool = tool; } } as unknown as ExtensionAPI, { list: () => [] } as unknown as Registry);
  expect((await listTool.execute('list', {}, undefined, undefined, ctx)).content[0].text);
  // Reload creates a new delivery consumer, retaining the report locator without output/log calls.
  for (let reload = 0; reload < 2; reload++) {
    const handlers: Record<string, any> = {}; let deliver!: (value: any) => void;
    const received = new Promise<any>(resolve => { deliver = resolve; });
    registerBridgeDelivery({ on(name: string, fn: any) { handlers[name] = fn; }, registerCommand() {}, sendMessage(message: any) { deliver(message); handlers.session_shutdown(); } } as unknown as ExtensionAPI);
    await handlers.session_start({}, ctx); const message = await received; expect(message.content); assert.equal(message.details.result?.path ?? null, result?.path ?? null);
    if (result) assert.match(message.content, /Historical settlement report:.*integrity: invalid; historical report, not current proof/);
  }
});

test('formatter reports actual tested metadata and does not hide invalid report integrity', () => {
  const text = formatHandoff({ status: 'done', result: { path: '/captured/result.md', sha256: 'hash', attempt: 2, status: 'PASS', claims: '', risks: '', evidence: '', integrity: 'invalid', proof: 'unknown', tested: { surface: { revision: 'actual-revision' }, producer: 'host', limitations: ['git-visible only'] }, limitation: 'Not an independent verdict' } });
  assert.match(text, /integrity: invalid; proof: unknown/); assert.match(text, /actual-revision/); assert.match(text, /git-visible only/);
});

test('root delivery consumer queues teammate advice while busy without claiming read or done', async t => {
  const dir = await mkdtemp('/tmp/detach-team-delivery-'); const modulePath = join(dir, 'client.mjs');
  await writeFile(modulePath, `export const PI_DETACH_CLIENT_VERSION = 1; let sent=false;
export function createPiDetachClient() { return { async request(session, action, payload) {
 if(action==='list') return [{runId:'pib-member',node:{}}];
 if(action==='wait' && !sent) { sent=true; return [{id:7,kind:'team.message',message:{id:'message-7',from:'pib-peer',fromName:'peer',text:'review the boundary',status:'queued'}}]; }
 if(action==='wait') return []; if(action==='ack') { globalThis.__teamDeliveryAck=payload; return {}; } throw Error(action);
} }; }`);
  const previous = { bridge: process.env.PI_DETACH_RUNTIME_BRIDGE, descriptor: process.env.ADVISOR_RUNTIME_DESCRIPTOR };
  process.env.PI_DETACH_RUNTIME_BRIDGE = modulePath; process.env.ADVISOR_RUNTIME_DESCRIPTOR = join(dir, 'descriptor');
  const record = globalThis as typeof globalThis & { __teamDeliveryAck?: unknown };
  t.after(async () => { if (previous.bridge === undefined) delete process.env.PI_DETACH_RUNTIME_BRIDGE; else process.env.PI_DETACH_RUNTIME_BRIDGE = previous.bridge; if (previous.descriptor === undefined) delete process.env.ADVISOR_RUNTIME_DESCRIPTOR; else process.env.ADVISOR_RUNTIME_DESCRIPTOR = previous.descriptor; delete record.__teamDeliveryAck; resetBridgeClients(); await rm(dir, { recursive: true, force: true }); });
  const handlers: Record<string, any> = {}; let delivered!: (value: any) => void;
  const received = new Promise<any>(resolve => { delivered = resolve; });
  registerBridgeDelivery({ on(name: string, fn: any) { handlers[name] = fn; }, registerCommand() {}, sendMessage(message: any, options: any) { delivered({ message, options }); } } as unknown as ExtensionAPI);
  const ctx = { cwd: dir, sessionManager: { getSessionId: () => 'owner', getEntries: () => [] }, isIdle: () => false, ui: { notify() {} } } as unknown as ExtensionContext;
  await handlers.session_start({}, ctx); const delivery = await received;
  assert.match(delivery.message.content, /does not grant scope or change any assignment/); assert.deepEqual(delivery.options, { deliverAs: 'steer' });
  assert.equal(delivery.message.details.read, null); assert.equal(delivery.message.details.done, null);
  for (let i = 0; i < 50 && !record.__teamDeliveryAck; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(record.__teamDeliveryAck, { runId: 'pib-member', deliveryId: 7 });
  handlers.session_shutdown();
});

test('root teammate advice dedupes repeated delivery and reconnect after lost ack within the same session', async t => {
  const dir = await mkdtemp('/tmp/detach-team-retry-'); const modulePath = join(dir, 'client.mjs');
  await writeFile(modulePath, `export const PI_DETACH_CLIENT_VERSION = 1; let waits=0, acks=0;
const delivery={id:7,kind:'team.message',message:{id:'message-7',from:'pib-peer',fromName:'peer',text:'one update',status:'queued'}};
export function createPiDetachClient() { return { async request(session, action) {
 if(action==='list') return [{runId:'pib-member',node:{}}];
 if(action==='wait') return ++waits===1 ? [delivery,delivery] : [delivery];
 if(action==='ack') { globalThis.__teamRetry.acks=++acks; if(acks===2) throw Error('lost ack'); if(acks===3) globalThis.__teamRetry.done(); return {}; }
 throw Error(action);
} }; }`);
  const previous = { bridge: process.env.PI_DETACH_RUNTIME_BRIDGE, descriptor: process.env.ADVISOR_RUNTIME_DESCRIPTOR };
  process.env.PI_DETACH_RUNTIME_BRIDGE = modulePath; process.env.ADVISOR_RUNTIME_DESCRIPTOR = join(dir, 'descriptor');
  const global = globalThis as typeof globalThis & { __teamRetry?: { acks: number; done(): void } };
  const consumers: Record<string, any>[] = []; const sent: any[] = [];
  // A foreign session's conversation entry is never receipt authority for this root.
  const entries: any[] = [{ type: 'message', message: { role: 'custom', customType: 'managed-team-message', details: { rootSession: 'foreign', runId: 'pib-member', messageId: 'message-7' } } }];
  let disconnected!: () => void; const lostAck = new Promise<void>(resolve => { disconnected = resolve; });
  const ctx = { cwd: dir, sessionManager: { getSessionId: () => 'owner', getEntries: () => entries }, isIdle: () => false, ui: { notify() { disconnected(); } } } as unknown as ExtensionContext;
  function consumer() {
    const handlers: Record<string, any> = {}; consumers.push(handlers);
    registerBridgeDelivery({ on(name: string, fn: any) { handlers[name] = fn; }, registerCommand() {}, sendMessage(message: any) { sent.push(message); entries.push({ type: 'message', message: { role: 'custom', ...message } }); } } as unknown as ExtensionAPI);
    return handlers;
  }
  t.after(async () => {
    for (const handler of consumers) handler.session_shutdown();
    if (previous.bridge === undefined) delete process.env.PI_DETACH_RUNTIME_BRIDGE; else process.env.PI_DETACH_RUNTIME_BRIDGE = previous.bridge;
    if (previous.descriptor === undefined) delete process.env.ADVISOR_RUNTIME_DESCRIPTOR; else process.env.ADVISOR_RUNTIME_DESCRIPTOR = previous.descriptor;
    delete global.__teamRetry; resetBridgeClients(); await rm(dir, { recursive: true, force: true });
  });
  global.__teamRetry = { acks: 0, done() {} };
  const first = consumer(); await first.session_start({}, ctx); await lostAck;
  assert.equal(sent.length, 1); assert.equal(global.__teamRetry.acks, 2); first.session_shutdown();
  const second = consumer(); let acked!: () => void; const receipt = new Promise<void>(resolve => { acked = resolve; });
  global.__teamRetry.done = () => { second.session_shutdown(); acked(); };
  await second.session_start({}, ctx); await receipt;
  assert.equal(sent.length, 1, 'reconnect re-acks persisted delivery without reinjection');
  assert.equal(global.__teamRetry.acks, 3); assert.equal(sent[0].details.rootSession, 'owner');
  assert.equal(sent[0].details.read, null); assert.equal(sent[0].details.done, null);
});
