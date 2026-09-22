import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { RuntimeClient } from './client';
import { RUNTIME_PROTOCOL_VERSION, receive, send } from './protocol';
import type { RuntimeExecution } from './types';

const execution: RuntimeExecution = {
  threadId: 'thread', taskId: 'task', runId: 'run',
  delegationId: 'delegation', workdir: process.cwd(),
};

async function peer(
  t: TestContext,
  onRequest: (socket: Socket, message: Record<string, unknown>) => void,
) {
  const directory = await mkdtemp(join(tmpdir(), 'ppr-client-'));
  const endpoint = process.platform === 'win32'
    ? '\\\\.\\pipe\\ppr-client-' + randomUUID()
    : join(directory, 'socket');
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    receive(socket, (message) => {
      if (message.op === 'hello') {
        send(socket, {
          id: message.id, ok: true,
          value: { clientId: randomUUID(), pid: process.pid, bindings: { bash: { instanceId: 'local', runtimeKind: 'shell' } } },
        });
      } else onRequest(socket, message);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const client = await RuntimeClient.connect({ endpoint, token: 'test-only-token', requirements: { bash: 'shell' } });
  t.after(() => client.close());
  return client;
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Pending Runtime request did not settle after protocol failure.')), 1000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('malformed error replies reject every pending request rather than orphaning the matched request', { timeout: 10_000 }, async (t) => {
  for (const errorReply of [
    { ok: false },
    { ok: false, error: 'invalid' },
    { ok: false, error: { code: 1, message: 'invalid code' } },
    { ok: false, error: { code: 'bad', message: [] } },
    { ok: 'false', error: { code: 'bad', message: 'invalid discriminant' } },
  ]) {
    await t.test(JSON.stringify(errorReply), async (t) => {
      let replied = false;
      const client = await peer(t, (socket, message) => {
        if (!replied) {
          replied = true;
          send(socket, { id: message.id, ...errorReply });
        }
      });
      const first = client.status();
      const second = client.status();
      await within(Promise.all([
        assert.rejects(first, { code: 'connection_lost' }),
        assert.rejects(second, { code: 'connection_lost' }),
      ]));
      assert.equal(client.isConnected, false);
      await assert.rejects(client.status(), { code: 'connection_lost' });
    });
  }
});

test('unexpected response identities and invalid JSON fail closed without resolving the wrong call', { timeout: 5000 }, async (t) => {
  for (const kind of ['unexpected-id', 'invalid-json']) {
    await t.test(kind, async (t) => {
      const client = await peer(t, (socket) => {
        if (kind === 'unexpected-id') send(socket, { id: 'not-a-pending-request', ok: true, value: 'wrong result' });
        else socket.write('not JSON\n');
      });
      await within(assert.rejects(client.status(), { code: 'connection_lost' }));
      assert.equal(client.isConnected, false);
    });
  }
});

test('valid structured errors preserve recovery details and leave the connection usable', async (t) => {
  let requests = 0;
  const client = await peer(t, (socket, message) => {
    if (++requests === 1) send(socket, { id: message.id, ok: false, error: {
      code: 'origin_changed', message: 'Explicit approval required.', retryable: false,
      details: { interactionDispatched: true },
    } });
    else send(socket, { id: message.id, ok: true, value: { pid: process.pid, protocol: RUNTIME_PROTOCOL_VERSION, instances: [] } });
  });
  await assert.rejects(client.status(), (error: unknown) => {
    const value = error as { code: string; retryable: boolean; details: unknown };
    assert.equal(value.code, 'origin_changed');
    assert.equal(value.retryable, false);
    assert.deepEqual(value.details, { interactionDispatched: true });
    return true;
  });
  assert.equal(client.isConnected, true);
  assert.deepEqual((await client.status()).instances, []);
});

test('the client rejects unbound/pre-cancelled calls locally and serializes only execution identity', async (t) => {
  const received: Record<string, unknown>[] = [];
  const client = await peer(t, (socket, message) => {
    received.push(message);
    send(socket, { id: message.id, ok: true, value: message.execution });
  });
  await assert.rejects(client.call('git', 'run', {}, execution), { code: 'forbidden' });
  await assert.rejects(client.call('bash', 'run', {}, execution, AbortSignal.abort()), { code: 'aborted' });
  const runtimeScope = { ...execution, signal: AbortSignal.abort(), internalOnly: 'must-not-cross' };
  assert.deepEqual(await client.call('bash', 'run', {}, runtimeScope), execution);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0]!.execution, execution);
});

test('cancellation targets the issued request and never replays an operation', async (t) => {
  const messages: Record<string, unknown>[] = [];
  const client = await peer(t, (socket, message) => {
    messages.push(message);
    if (message.op === 'cancel') send(socket, { id: message.requestId, ok: true, value: { cancelled: true } });
  });
  const controller = new AbortController();
  const operation = client.call('bash', 'run', {}, execution, controller.signal);
  controller.abort();
  assert.deepEqual(await within(operation), { cancelled: true });
  assert.deepEqual(messages.map((message) => message.op), ['call', 'cancel']);
  assert.equal(messages[1]!.requestId, messages[0]!.id);
});
