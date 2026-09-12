import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentExecutionPort } from '../src/execution-port.ts';
import { createPaneManager } from '../src/herdr/panes.ts';
import type { HerdrCli } from '../src/herdr/cli.ts';

test('recursive delegation uses trusted per-launch child scope, never ambient parent grant', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'port-scope-'));
  const profile = join(directory, 'profiles.json');
  writeFileSync(profile, JSON.stringify({ defaultAgent: 'pi', profiles: { advisor: { agent: 'pi', cliArgs: ['--advisor-worker-allow-subagents'] }, specialist: { agent: 'pi' } } }));
  const saved = { ...process.env };
  process.env.PI_DETACH_AGENT_PROFILES = profile;
  process.env.ADVISOR_BRIDGE_CHILD_STATE = '/parent/reserved';
  delete process.env.PI_DETACH_WORKER_HARNESS;
  const cli = { exec() { throw new Error('preparation never acquires a pane'); }, spawnWaiter() { throw new Error('no observation before admission'); } } as unknown as HerdrCli;
  const ctx = { paneId: 'w1:p1' };
  const port = createAgentExecutionPort({ cli, ctx, panes: createPaneManager(cli, ctx), env: { ADVISOR_RUNTIME_DESCRIPTOR: '/forbidden-parent-credential', ADVISOR_BRIDGE_CHILD_STATE: '/forbidden-parent-grant' } });
  try {
    const scope = { childState: '/family/c/next', workstream: 'workstream', workerHarness: 'native' as const };
    const child = await port.prepare({ role: 'advisor', prompt: 'own outcome' }, '/worker/source', scope);
    assert.equal(child.environment.ADVISOR_BRIDGE_CHILD_STATE, scope.childState);
    assert.equal(child.environment.ADVISOR_RUNTIME_DESCRIPTOR, '');
    assert.equal(child.environment.ADVISOR_WORKSTREAM, 'workstream');
    assert.equal(child.environment.PI_DETACH_WORKER_HARNESS, 'native');
    assert.equal(child.harness, 'pi');
    const specialist = await port.prepare({ role: 'specialist', prompt: 'leaf', model: 'openai-codex/example' }, '/worker/source', scope);
    assert.equal(specialist.environment.ADVISOR_BRIDGE_CHILD_STATE, '');
    assert.equal(specialist.harness, 'native', 'trusted family preference also controls specialist execution');
    await assert.rejects(port.prepare({ role: 'specialist', prompt: 'forbidden', harness: 'pi' }, '/worker/source', scope), /harness pi conflicts with the parent session harness native/);
    assert.equal((await port.prepare({ role: 'advisor', prompt: 'no trusted reservation' }, '/worker/source')).environment.ADVISOR_BRIDGE_CHILD_STATE, '');
    await assert.rejects(port.prepare({ role: 'advisor', prompt: 'untrusted extra field', childState: '/foreign' }, '/worker/source', scope), /BRIDGE_INVALID_INPUT/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved); rmSync(directory, { recursive: true, force: true });
  }
});
