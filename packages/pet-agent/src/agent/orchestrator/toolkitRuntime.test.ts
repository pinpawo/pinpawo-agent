import assert from 'node:assert/strict';
import test from 'node:test';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { defineToolkit } from '../../types/toolkit';
import { ToolkitRuntimeManager, type ToolkitRuntimeClientBinding } from './toolkitRuntime';

const client = { execute: async (input: string) => input };
const binding = (instanceId = 'shared', clientId = 'host-1'): ToolkitRuntimeClientBinding => ({
  runtimeType: 'shell', client, identity: { clientId, instanceId },
});
const toolkit = (name: string, runtime: string | undefined = 'shell') => defineToolkit({
  name, description: name, runtime,
  tools: [{ tool: tool(() => name, { name: `${name}_tool`, description: name, schema: z.object({}) }) }],
});

test('selection injects only chosen Toolkit clients and preserves the static inventory', () => {
  const bash = toolkit('bash');
  const git = toolkit('git');
  const manager = new ToolkitRuntimeManager({ bash: binding(), git: binding() });
  const original = bash.tools[0];
  const selected = manager.select([bash]);
  assert.deepEqual(Object.keys(selected.runtimes), ['bash']);
  assert.strictEqual(selected.runtimes.bash, client);
  assert.strictEqual(bash.tools[0], original);
  assert.strictEqual(bash.tools[0].tool.schema, original.tool.schema);
  assert.equal(Object.isFrozen(selected.runtimes), true);
  assert.deepEqual(manager.select([git]).identities.git, { clientId: 'host-1', instanceId: 'shared' });
});

test('Toolkits may share or isolate environment identities without lifecycle calls', async () => {
  const manager = new ToolkitRuntimeManager({ bash: binding(), git: binding('git') });
  const [first, second] = await Promise.all([
    Promise.resolve(manager.select([toolkit('bash')])),
    Promise.resolve(manager.select([toolkit('git')])),
  ]);
  assert.strictEqual(first.runtimes.bash, second.runtimes.git);
  assert.notEqual(first.identities.bash.instanceId, second.identities.git.instanceId);
  assert.deepEqual(manager.select([{ ...toolkit('format'), runtime: undefined }]), { runtimes: {}, identities: {} });
});

test('missing and incompatible Runtime clients fail before tools can execute', () => {
  assert.throws(() => new ToolkitRuntimeManager().select([toolkit('bash')]), /no client is configured/);
  assert.throws(() => new ToolkitRuntimeManager({ bash: { ...binding(), runtimeType: 'cdp' } }).select([toolkit('bash')]), /received "cdp"/);
});

test('binding replacement snapshots trusted identity and leaves prior selections immutable', () => {
  const mutable = { runtimeType: 'shell', client, identity: { clientId: 'old', instanceId: 'shared' } };
  const manager = new ToolkitRuntimeManager({ bash: mutable });
  mutable.identity.clientId = 'forged';
  const previous = manager.select([toolkit('bash')]);
  manager.replaceBindings({ bash: binding('new-env', 'new-host') });
  const current = manager.select([toolkit('bash')]);
  assert.equal(previous.identities.bash.clientId, 'old');
  assert.deepEqual(current.identities.bash, { clientId: 'new-host', instanceId: 'new-env' });
  assert.throws(() => manager.replaceBindings({ bash: { ...binding(), identity: { clientId: '', instanceId: 'bad' } } }), /Invalid Runtime/);
  assert.equal(manager.select([toolkit('bash')]).identities.bash.clientId, 'new-host');
  manager.replaceBindings({});
  assert.throws(() => manager.select([toolkit('bash')]), /no client/);
});

test('diagnostics query the client and isolate failures without owning resources', async () => {
  let calls = 0;
  const manager = new ToolkitRuntimeManager({
    bash: { ...binding(), diagnose: async () => { calls += 1; return { status: 'ready', processes: 2 }; } },
    git: { ...binding('git'), diagnose: () => { throw new Error('connection closed'); } },
  });
  const diagnostics = await manager.diagnose();
  assert.equal(calls, 1);
  assert.deepEqual(diagnostics[0].details, { status: 'ready', processes: 2 });
  assert.equal(diagnostics[1].error, 'connection closed');
  assert.equal(manager.select([toolkit('bash')]).runtimes.bash, client);
});

test('reserved object property names remain ordinary Toolkit names', () => {
  const manager = new ToolkitRuntimeManager({ ['__proto__']: binding() });
  const selected = manager.select([toolkit('__proto__')]);
  assert.equal(Object.hasOwn(selected.runtimes, '__proto__'), true);
  assert.strictEqual(selected.runtimes.__proto__, client);
  assert.throws(() => manager.select([toolkit('toString')]), /no client/);
});
