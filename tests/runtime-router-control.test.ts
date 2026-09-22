import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerBridgeDelivery, resetBridgeClients } from '../src/runtime-bridge.ts';

test('private router controls can bootstrap early, but require exact session context and action', async t => {
  const dir = await mkdtemp('/tmp/detach-router-control-');
  const modulePath = join(dir, 'client.mjs');
  await writeFile(modulePath, `export const PI_DETACH_CLIENT_VERSION = 1;
export const calls = [];
export function createPiDetachClient() { return { async request(sessionId, action, payload) {
  calls.push({sessionId, action, payload}); return action === 'list' ? [] : {sessionId, action, payload};
} }; }`);
  const { calls } = await import(pathToFileURL(modulePath).href);
  const keys = ['PI_DETACH_RUNTIME_BRIDGE', 'ADVISOR_RUNTIME_DESCRIPTOR', 'PI_DETACH_BACKEND', 'AGENT_MESSAGE_DESCRIPTOR'];
  const before = keys.map(key => process.env[key]);
  process.env.PI_DETACH_RUNTIME_BRIDGE = modulePath;
  process.env.ADVISOR_RUNTIME_DESCRIPTOR = join(dir, 'descriptor');
  delete process.env.PI_DETACH_BACKEND;
  delete process.env.AGENT_MESSAGE_DESCRIPTOR;
  resetBridgeClients();
  const handlers = new Map<string, Function>();
  registerBridgeDelivery({
    events: { on(name: string, handler: Function) { handlers.set(name, handler); } },
    on(name: string, handler: Function) { handlers.set(name, handler); },
    registerCommand() {},
  } as unknown as ExtensionAPI);
  t.after(async () => {
    handlers.get('session_shutdown')!();
    keys.forEach((key, index) => { const value = before[index]; if (value === undefined) delete process.env[key]; else process.env[key] = value; });
    resetBridgeClients(); await rm(dir, { recursive: true, force: true });
  });
  const context = { cwd: dir, sessionManager: { getSessionId: () => 'owner', getEntries: () => [] }, ui: { notify() {} } } as unknown as ExtensionContext;
  function emit(sessionId: string, action: string, withContext: boolean | ExtensionContext = true) {
    const request: {sessionId: string; action: string; payload: Record<string, unknown>; context?: ExtensionContext; response?: Promise<unknown>} = {
      sessionId, action, payload: action === 'router.set' ? {enabled: false, expectedGeneration: 0} : {},
      ...(withContext ? {context: withContext === true ? context : withContext} : {}),
    };
    handlers.get('pi-detach:request')!(request); return request;
  }
  for (const action of ['router.status', 'router.set']) {
    const request = emit('owner', action);
    assert.ok(request.response, 'works before bridge session_start');
    assert.deepEqual(await request.response, {sessionId: 'owner', action, payload: request.payload});
    assert.equal(emit('foreign', action).response, undefined);
    assert.equal(emit('owner', action, false).response, undefined);
  }
  for (const action of ['call', 'shutdown', 'router.anything', 'supervision']) assert.equal(emit('owner', action).response, undefined);
  assert.equal(calls.length, 2);
  const foreign = { ...context, sessionManager: { getSessionId: () => 'owner', getEntries: () => [] } } as unknown as ExtensionContext;
  const wrapper = { ...context };
  for (const action of ['router.status', 'router.set']) {
    assert.equal(emit('owner', action, foreign).response, undefined, 'same-ID foreign manager cannot bootstrap');
    assert.equal(emit('owner', action, wrapper).response, undefined, 'first early event pins the exact startup wrapper');
  }
  await handlers.get('session_start')!({}, context);
  for (const action of ['router.status', 'router.set']) {
    assert.equal(emit('owner', action, foreign).response, undefined, 'same-ID foreign manager is not authoritative');
    assert.equal(emit('owner', action, { ...context, cwd: '/' }).response, undefined, 'foreign cwd is not authoritative');
    assert.ok(await emit('owner', action, wrapper).response, 'fresh SDK hook/command wrapper shares the real manager');
  }
  await handlers.get('session_start')!({}, foreign); // Only the SDK lifecycle may bind a replacement manager.
  handlers.get('session_shutdown')!({}, context); // Stale shutdown cannot clear the replacement scope.
  assert.equal(emit('owner', 'router.set', context).response, undefined);
  assert.ok(await emit('owner', 'router.set', foreign).response);
  handlers.get('session_shutdown')!({}, foreign);
  assert.ok(await emit('owner', 'router.status', context).response);
  await handlers.get('session_start')!({}, wrapper);
  await assert.rejects(emit('owner', 'router.set', context).response!, /PI_DETACH_CONTEXT_MISMATCH/, 'different startup wrapper fences the early scope');
  process.env.PI_DETACH_BACKEND = 'legacy';
  assert.equal(emit('owner', 'router.set').response, undefined);
});
