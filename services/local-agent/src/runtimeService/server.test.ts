import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RuntimeClient } from './client';
import { startRuntimeService } from './server';
import { RuntimeServiceError } from './protocol';
import type { RuntimeExecution, RuntimeFactory } from './types';

const execution: RuntimeExecution = {
  taskId: 'task', threadId: 'same-thread', runId: 'same-run',
  delegationId: 'same-delegation', workdir: process.cwd(),
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ppr-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\test-${Date.now()}-${Math.random()}` : join(directory, 's');
  let created = 0;
  const released: string[] = [];
  const resources = new Map<string, { client: string; toolkit: string }>();
  const factory: RuntimeFactory = () => {
    const environment = ++created;
    return {
      async call(method, args, context) {
        if (method === 'environment') return environment;
        if (method === 'create') {
          await delay(Number(args ?? 0));
          const id = `${environment}:${Math.random()}`;
          resources.set(id, { client: context.clientId, toolkit: context.toolkitName });
          return id;
        }
        if (method === 'read') {
          const resource = resources.get(String(args));
          if (!resource || resource.client !== context.clientId || resource.toolkit !== context.toolkitName) {
            throw new RuntimeServiceError('not_owner', 'Resource does not belong to this caller.');
          }
          return 'owned';
        }
        if (method === 'wait') {
          await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
          return { cancelled: true };
        }
        if (method === 'browser-error') {
          throw Object.assign(new Error('Cross-origin navigation needs approval.'), {
            code: 'origin_changed', retryable: false, details: { interactionDispatched: true },
          });
        }
        if (method === 'circular-error') {
          const details: Record<string, unknown> = {};
          details.self = details;
          throw Object.assign(new Error('Extension operation failed.'), { details });
        }
        throw new Error('Unknown operation');
      },
      async releaseClient(clientId) {
        released.push(clientId);
        for (const [id, resource] of resources) if (resource.client === clientId) resources.delete(id);
      },
      async close() { resources.clear(); },
      diagnose() { return { environment }; },
    };
  };
  const service = await startRuntimeService({
    endpoint, token: 'test-token',
    config: {
      instances: { shared: { kind: 'test' }, separate: { kind: 'test' } },
      toolkitBindings: { bash: 'shared', git: 'shared', isolated: 'separate' },
    }, factories: { test: factory },
  });
  const clients: RuntimeClient[] = [];
  return {
    resources, released,
    async connect(requirements: Record<string, string>, administrative = false) {
      const client = await RuntimeClient.connect({ endpoint, token: 'test-token', requirements, administrative });
      clients.push(client);
      return client;
    },
    endpoint,
    async close() {
      await Promise.all(clients.map((client) => client.close()));
      await service.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('two clients share configured instances but never resource ownership; separate IDs create separate environments', async () => {
  const service = await fixture();
  try {
    const a = await service.connect({ bash: 'test', git: 'test' });
    const b = await service.connect({ bash: 'test', isolated: 'test' });
    assert.notEqual(a.clientId, b.clientId);
    const [sharedA, sharedB, git, isolated] = await Promise.all([
      a.call('bash', 'environment', null, execution), b.call('bash', 'environment', null, execution),
      a.call('git', 'environment', null, execution), b.call('isolated', 'environment', null, execution),
    ]);
    assert.equal(sharedA, sharedB);
    assert.equal(git, sharedA);
    assert.notEqual(isolated, sharedA);
    const handle = await a.call('bash', 'create', null, execution);
    assert.equal(await a.call('bash', 'read', handle, execution), 'owned');
    await assert.rejects(b.call('bash', 'read', handle, execution), { code: 'not_owner' });
    await assert.rejects(a.call('git', 'read', handle, execution), { code: 'not_owner' });
    await assert.rejects(a.call('isolated', 'environment', null, execution), { code: 'forbidden' });
    await assert.rejects(a.stopService(), { code: 'forbidden' });
    const bHandle = await b.call('bash', 'create', null, execution);
    await a.close();
    for (let i = 0; i < 50 && service.resources.has(String(handle)); i += 1) await delay(10);
    assert.equal(service.resources.has(String(handle)), false);
    assert.equal(await b.call('bash', 'read', bHandle, execution), 'owned');
    const replacement = await service.connect({ bash: 'test' });
    await assert.rejects(replacement.call('bash', 'read', handle, execution), { code: 'not_owner' });
  } finally { await service.close(); }
});

test('cancellation reaches the running operation and disconnect cleans resources created in flight', async () => {
  const service = await fixture();
  try {
    const a = await service.connect({ bash: 'test' });
    const controller = new AbortController();
    const waiting = a.call('bash', 'wait', null, execution, controller.signal);
    await delay(30);
    controller.abort();
    assert.deepEqual(await waiting, { cancelled: true });
    const pending = a.call('bash', 'create', 60, execution);
    const rejected = assert.rejects(pending, { code: 'connection_lost' });
    await delay(15);
    await a.close();
    await rejected;
    await delay(100);
    assert.equal(service.resources.size, 0);
    assert.ok(service.released.includes(a.clientId));
  } finally { await service.close(); }
});

test('authentication, binding validation and structured operation errors cross the same IPC boundary', async () => {
  const service = await fixture();
  try {
    await assert.rejects(RuntimeClient.connect({ endpoint: service.endpoint, token: 'wrong', requirements: {} }), { code: 'authentication_failed' });
    await assert.rejects(service.connect({ bash: 'wrong-interface' }), { code: 'binding_mismatch' });
    const a = await service.connect({ bash: 'test' });
    await assert.rejects(a.call('bash', 'browser-error', null, execution), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'origin_changed');
      assert.deepEqual((error as { details: unknown }).details, { interactionDispatched: true });
      return true;
    });
    assert.equal((await a.status()).instances.length, 1);
    await assert.rejects(a.call('bash', 'circular-error', null, execution), {
      code: 'runtime_error', message: 'Extension operation failed.',
    });
    assert.equal((await a.status()).instances[0].state, 'ready', 'extension errors leave the shared service available');
  } finally { await service.close(); }
});
