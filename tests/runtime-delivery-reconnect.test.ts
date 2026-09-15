import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionAPI, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import { registerBridgeDelivery, resetBridgeClients } from '../src/runtime-bridge.ts';

for (const fault of ['list', 'wait', 'ack']) test(`completion delivery reconnects after ${fault} failure without duplicate wake or worker execution`, { timeout: 5000 }, async t => {
  const dir = await mkdtemp('/tmp/detach-reconnect-');
  const modulePath = join(dir, 'client.mjs');
  await writeFile(modulePath, `export const PI_DETACH_CLIENT_VERSION = 1;
export const state = { calls: [], counts: {}, done() {} };
export function createPiDetachClient() { return { async request(session, action, payload) {
  if (session !== 'owner') throw Error('wrong owner');
  state.calls.push(action); state.counts[action] = (state.counts[action] || 0) + 1;
  if (action === '${fault}' && state.counts[action] <= 2) throw Error('PI_DETACH_BRIDGE_UNAVAILABLE');
  if (action === 'list') return [{ runId: 'pib-worker', node: {} }];
  if (action === 'wait') return [{ id: 5, kind: 'settled', status: 'done', reason: 'captured result' }];
  if (action === 'ack') { state.done(); return {}; }
  throw Error('unexpected execution: ' + action);
} }; }
`);
  const { state } = await import(pathToFileURL(modulePath).href);
  const before = { bridge: process.env.PI_DETACH_RUNTIME_BRIDGE, descriptor: process.env.ADVISOR_RUNTIME_DESCRIPTOR, backend: process.env.PI_DETACH_BACKEND };
  process.env.PI_DETACH_RUNTIME_BRIDGE = modulePath;
  process.env.ADVISOR_RUNTIME_DESCRIPTOR = join(dir, 'descriptor');
  delete process.env.PI_DETACH_BACKEND;
  const consumers: Record<string, any>[] = [];
  const entries: SessionEntry[] = [{ type: 'custom_message', id: 'foreign', parentId: null, timestamp: new Date().toISOString(), customType: 'pi-detach-runtime', content: '', display: true, details: { rootSession: 'foreign', runId: 'pib-worker', deliveryId: 5 } }];
  const sent: any[] = []; const notifications: string[] = [];
  const ctx = { cwd: dir, sessionManager: { getSessionId: () => 'owner', getEntries: () => entries }, isIdle: () => true, ui: { notify(message: string) { notifications.push(message); } } } as unknown as ExtensionContext;
  t.after(async () => {
    for (const handler of consumers) handler.session_shutdown();
    for (const [key, value] of Object.entries({ PI_DETACH_RUNTIME_BRIDGE: before.bridge, ADVISOR_RUNTIME_DESCRIPTOR: before.descriptor, PI_DETACH_BACKEND: before.backend })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetBridgeClients(); await rm(dir, { recursive: true, force: true });
  });
  function consumer() {
    const handlers: Record<string, any> = {}; consumers.push(handlers);
    registerBridgeDelivery({ on(name: string, handler: any) { handlers[name] = handler; }, registerCommand() {}, sendMessage(message: any, options: any) {
      sent.push({ message, options }); entries.push({ type: 'custom_message', id: `notification-${sent.length}`, parentId: null, timestamp: new Date().toISOString(), ...message });
    } } as unknown as ExtensionAPI);
    return handlers;
  }
  const first = consumer();
  const received = new Promise<void>(resolve => { state.done = () => { first.session_shutdown(); resolve(); }; });
  await first.session_start({}, ctx); await received;
  assert.equal(state.counts[fault], 3, 'transient failures retry without session reload');
  assert.equal(sent.length, 1, 'a lost ACK must not wake the advisor twice');
  assert.deepEqual(sent[0].options, { triggerTurn: true });
  assert.equal(sent[0].message.details.rootSession, 'owner');
  assert.equal(notifications.length, 1, 'one warning per disconnect, not per attempt');
  assert.match(notifications[0]!, /reconnecting automatically/);

  // Persisted notification is re-acked, not re-injected, if the session reloads.
  const second = consumer();
  const reacked = new Promise<void>(resolve => { state.done = () => { second.session_shutdown(); resolve(); }; });
  await second.session_start({}, ctx); await reacked;
  assert.equal(sent.length, 1);
  assert.ok(state.calls.every((action: string) => ['list', 'wait', 'ack'].includes(action)));
});
