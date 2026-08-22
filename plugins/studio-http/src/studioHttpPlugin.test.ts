import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  StudioDispatchReceipt,
  StudioDispatchRequest,
  StudioEvent,
  StudioEventHandler,
  StudioPluginContext,
} from '@pinpawo/studio';

import { createStudioHttpPlugin } from './studioHttpPlugin';

const AUTH_TOKEN = 'test-token-with-at-least-16-characters';

function receipt(request: StudioDispatchRequest): StudioDispatchReceipt {
  const result = {
    petId: request.petId,
    threadId: `thread:${request.petId}`,
    invocationId: 'invocation-1',
    status: 'completed' as const,
    ...(request.metadata ? { metadata: request.metadata } : {}),
  };
  return {
    petId: result.petId,
    threadId: result.threadId,
    invocationId: result.invocationId,
    ...(request.metadata ? { metadata: request.metadata } : {}),
    onInvocation: (handler) => {
      void handler(result);
      return () => undefined;
    },
    completion: Promise.resolve(result),
  };
}

function createContext(options: {
  dispatch?: (request: StudioDispatchRequest) => Promise<StudioDispatchReceipt>;
} = {}) {
  const eventHandlers = new Set<StudioEventHandler>();
  const requests: StudioDispatchRequest[] = [];
  const context: StudioPluginContext = {
    dispatch: async (request) => {
      requests.push(request);
      return options.dispatch ? options.dispatch(request) : receipt(request);
    },
    onInvocation: () => () => undefined,
    notify: () => undefined,
    subscribe: (handler) => {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    listPets: () => [],
    hooks: {
      expose: () => () => undefined,
      contribute: () => () => undefined,
    },
  };
  return {
    context,
    requests,
    subscriberCount: () => eventHandlers.size,
    emit: async (event: StudioEvent) => {
      await Promise.all([...eventHandlers].map((handler) => handler(event)));
    },
  };
}

function pluginUrl(port: number, path: string): string {
  return `http://127.0.0.1:${port.toString()}${path}`;
}

async function readStreamUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timed out waiting for SSE data')), 2_000);
    timer.unref();
  });
  try {
    return await Promise.race([
      (async () => {
        while (!predicate(text)) {
          const next = await reader.read();
          if (next.done) throw new Error('SSE stream closed before expected data arrived');
          text += decoder.decode(next.value, { stream: true });
        }
        return text;
      })(),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('HTTP Plugin dispatches a validated request and returns receipt identity', async (t) => {
  const harness = createContext();
  const plugin = createStudioHttpPlugin({ port: 0, authToken: AUTH_TOKEN });
  assert.deepEqual(plugin.toolkits, []);
  await plugin.start(harness.context);
  t.after(() => plugin.stop());
  const address = plugin.address();
  assert.ok(address);

  const response = await fetch(pluginUrl(address.port, '/dispatch'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      petId: 'planner',
      input: { kind: 'request', request: 'plan this work' },
      idempotencyKey: 'retry-1',
    }),
  });

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    petId: 'planner',
    threadId: 'thread:planner',
    invocationId: 'invocation-1',
  });
  assert.deepEqual(harness.requests, [{
    petId: 'planner',
    input: { kind: 'request', request: 'plan this work' },
    idempotencyKey: 'retry-1',
  }]);
});

test('HTTP Plugin requires bearer auth and an explicitly allowed browser origin', async (t) => {
  const harness = createContext();
  const plugin = createStudioHttpPlugin({
    port: 0,
    authToken: AUTH_TOKEN,
    allowedOrigins: ['http://localhost:3000'],
  });
  await plugin.start(harness.context);
  t.after(() => plugin.stop());
  const address = plugin.address();
  assert.ok(address);
  const url = pluginUrl(address.port, '/dispatch');

  const unauthorized = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ petId: 'planner', input: { kind: 'request', request: 'x' } }),
  });
  assert.equal(unauthorized.status, 401);

  const forbidden = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json',
      Origin: 'https://evil.example',
    },
    body: JSON.stringify({ petId: 'planner', input: { kind: 'request', request: 'x' } }),
  });
  assert.equal(forbidden.status, 403);

  const preflight = await fetch(url, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:3000',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /Authorization/);
});

test('HTTP Plugin validates media type, body size, dispatch shape, and domain rejection', async (t) => {
  const harness = createContext({
    dispatch: async () => { throw new Error('unknown pet'); },
  });
  const plugin = createStudioHttpPlugin({
    port: 0,
    authToken: AUTH_TOKEN,
    maxBodyBytes: 128,
  });
  await plugin.start(harness.context);
  t.after(() => plugin.stop());
  const address = plugin.address();
  assert.ok(address);
  const url = pluginUrl(address.port, '/dispatch');
  const authorization = { Authorization: `Bearer ${AUTH_TOKEN}` };

  const wrongMediaType = await fetch(url, {
    method: 'POST',
    headers: authorization,
    body: '{}',
  });
  assert.equal(wrongMediaType.status, 415);

  const invalid = await fetch(url, {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ petId: 'planner' }),
  });
  assert.equal(invalid.status, 400);

  const oversized = await fetch(url, {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'x'.repeat(256) }),
  });
  assert.equal(oversized.status, 413);

  const rejected = await fetch(url, {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ petId: 'missing', input: { kind: 'request', request: 'x' } }),
  });
  assert.equal(rejected.status, 422);
  assert.deepEqual(await rejected.json(), { error: 'unknown pet' });
});

test('HTTP Plugin projects live Studio events over SSE and releases the subscription on stop', async () => {
  const harness = createContext();
  const plugin = createStudioHttpPlugin({
    port: 0,
    authToken: AUTH_TOKEN,
    heartbeatIntervalMs: 60_000,
  });
  await plugin.start(harness.context);
  const address = plugin.address();
  assert.ok(address);
  assert.equal(harness.subscriberCount(), 1);

  const controller = new AbortController();
  const response = await fetch(pluginUrl(address.port, '/events'), {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.ok(response.body);
  const reader = response.body.getReader();
  await readStreamUntil(reader, (text) => text.includes(': connected'));

  const event: StudioEvent = {
    type: 'task.done',
    source: 'kanban',
    payload: { taskId: 'task-1' },
    occurredAt: '2026-08-23T00:00:00.000Z',
  };
  await harness.emit(event);
  const stream = await readStreamUntil(reader, (text) => text.includes('task.done'));
  assert.match(stream, /event: studio\.event/);
  assert.match(stream, /"source":"kanban"/);

  await plugin.stop();
  assert.equal(plugin.address(), null);
  assert.equal(harness.subscriberCount(), 0);
  controller.abort();
});

test('HTTP Plugin rejects invalid security and resource options eagerly', () => {
  assert.throws(
    () => createStudioHttpPlugin({ port: -1, authToken: AUTH_TOKEN }),
    /port must be an integer/,
  );
  assert.throws(
    () => createStudioHttpPlugin({ port: 0, authToken: 'short' }),
    /at least 16 characters/,
  );
  assert.throws(
    () => createStudioHttpPlugin({
      port: 0,
      authToken: AUTH_TOKEN,
      allowedOrigins: ['file:///tmp/frontend.html'],
    }),
    /must be an HTTP\(S\) origin/,
  );
});
