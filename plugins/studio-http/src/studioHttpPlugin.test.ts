import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  StudioDispatchReceipt,
  StudioDispatchRequest,
  StudioEvent,
  StudioEventHandler,
  StudioInvocationEvent,
  StudioInvocationEventHandler,
  StudioPetRegistration,
  StudioPluginContext,
} from '@pinpawo/studio';

import {
  createStudioHttpPlugin,
  STUDIO_HTTP_STATIC_HOOK_NAME,
  type StudioHttpRoutesHook,
  type StudioHttpStaticHook,
} from './studioHttpPlugin';

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
  pets?: StudioPetRegistration[];
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
    listPets: () => options.pets ?? [],
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

test('HTTP Plugin exposes its dispatch queue and invocation progress', async (t) => {
  const invocationHandlers = new Set<StudioInvocationEventHandler>();
  const harness = createContext({
    dispatch: async (request) => ({
      petId: request.petId,
      threadId: `thread:${request.petId}`,
      invocationId: 'invocation-queued',
      onInvocation: (handler) => {
        invocationHandlers.add(handler);
        return () => invocationHandlers.delete(handler);
      },
      completion: new Promise(() => undefined),
    }),
  });
  const plugin = createStudioHttpPlugin({ port: 0, authToken: AUTH_TOKEN });
  await plugin.start(harness.context);
  t.after(() => plugin.stop());
  const address = plugin.address();
  assert.ok(address);
  const authorization = { Authorization: `Bearer ${AUTH_TOKEN}` };

  const accepted = await fetch(pluginUrl(address.port, '/dispatch'), {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      petId: 'planner',
      input: { kind: 'request', request: 'split this goal into Kanban tasks' },
    }),
  });
  assert.equal(accepted.status, 202);

  const readDispatches = async () => {
    const response = await fetch(pluginUrl(address.port, '/dispatches'), {
      headers: authorization,
    });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ dispatches: Array<{
      status: string;
      input: unknown;
      pendingContinuation?: unknown;
    }> }>;
  };
  assert.deepEqual((await readDispatches()).dispatches.map(({ status }) => status), ['queued']);

  const emitInvocation = async (event: StudioInvocationEvent) => {
    await Promise.all([...invocationHandlers].map((handler) => handler(event)));
  };
  const identity = {
    petId: 'planner',
    threadId: 'thread:planner',
    invocationId: 'invocation-queued',
  };
  await emitInvocation({ ...identity, status: 'busy' });
  assert.deepEqual((await readDispatches()).dispatches.map(({ status }) => status), ['busy']);

  await emitInvocation({
    ...identity,
    status: 'waiting',
    pendingContinuation: {
      continuationId: 'continuation-1',
      payload: { kind: 'human_review' },
    },
  });
  const [waiting] = (await readDispatches()).dispatches;
  assert.equal(waiting?.status, 'waiting');
  assert.deepEqual(waiting?.input, {
    kind: 'request',
    request: 'split this goal into Kanban tasks',
  });
  assert.deepEqual(waiting?.pendingContinuation, {
    continuationId: 'continuation-1',
    payload: { kind: 'human_review' },
  });
  assert.equal(invocationHandlers.size, 0);

  const retry = await fetch(pluginUrl(address.port, '/dispatch'), {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      petId: 'planner',
      input: { kind: 'request', request: 'split this goal into Kanban tasks' },
      idempotencyKey: 'same-dispatch',
    }),
  });
  assert.equal(retry.status, 202);
  assert.deepEqual((await readDispatches()).dispatches.map(({ status }) => status), ['waiting']);
});

test('HTTP Plugin exposes Studio Pet registrations without Agent-private actor fields', async (t) => {
  const harness = createContext({
    pets: [{
      petId: 'planner',
      name: 'Planner',
      role: 'plans work',
      serviceSummary: null,
      startupMode: 'standby',
      status: 'standby',
      capabilities: [{
        name: 'plan',
        description: 'Plans work.',
        available: true,
        reason: null,
      }],
    }],
  });
  const plugin = createStudioHttpPlugin({ port: 0, authToken: AUTH_TOKEN });
  await plugin.start(harness.context);
  t.after(() => plugin.stop());
  const address = plugin.address();
  assert.ok(address);

  const response = await fetch(pluginUrl(address.port, '/pets'), {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { pets: harness.context.listPets() });
});

test('HTTP Plugin permits unauthenticated loopback calls while rejecting foreign origins', async (t) => {
  const harness = createContext();
  const plugin = createStudioHttpPlugin({ port: 0 });
  await plugin.start(harness.context);
  t.after(() => plugin.stop());
  const address = plugin.address();
  assert.ok(address);

  const pets = await fetch(pluginUrl(address.port, '/pets'));
  assert.equal(pets.status, 200);

  const dispatch = await fetch(pluginUrl(address.port, '/dispatch'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      petId: 'planner',
      input: { kind: 'request', request: 'plan this work' },
    }),
  });
  assert.equal(dispatch.status, 202);

  const crossOrigin = await fetch(pluginUrl(address.port, '/pets'), {
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(crossOrigin.status, 403);
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

test('HTTP Plugin dispatches contributed routes through its shared Hono middleware', async (t) => {
  const harness = createContext();
  let routes: StudioHttpRoutesHook | undefined;
  harness.context.hooks = {
    expose: (hookName, hook) => {
      if (hookName === 'routes') {
        routes = hook as StudioHttpRoutesHook;
        return () => {
          routes = undefined;
        };
      }
      if (hookName === STUDIO_HTTP_STATIC_HOOK_NAME) return () => undefined;
      assert.fail(`unexpected HTTP hook ${hookName}`);
    },
    contribute: () => () => undefined,
  };
  const plugin = createStudioHttpPlugin({ port: 0, authToken: AUTH_TOKEN });
  await plugin.start(harness.context);
  t.after(() => plugin.stop());
  assert.ok(routes);
  const unregister = routes.register({
    method: 'GET',
    path: '/plugin-status',
    handle: ({ headers }) => ({
      kind: 'json',
      body: { accepted: headers.authorization === `Bearer ${AUTH_TOKEN}` },
    }),
  });
  const address = plugin.address();
  assert.ok(address);

  const response = await fetch(pluginUrl(address.port, '/plugin-status'), {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: true });

  const wrongMethod = await fetch(pluginUrl(address.port, '/plugin-status'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET, OPTIONS');

  unregister();
  const unregistered = await fetch(pluginUrl(address.port, '/plugin-status'), {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  });
  assert.equal(unregistered.status, 404);
});

test('HTTP Plugin serves lifecycle-managed packaged static mounts', async (t) => {
  const harness = createContext();
  let staticFiles: StudioHttpStaticHook | undefined;
  harness.context.hooks.expose = (hookName, hook) => {
    if (hookName === STUDIO_HTTP_STATIC_HOOK_NAME) staticFiles = hook as StudioHttpStaticHook;
    return () => { staticFiles = undefined; };
  };
  const plugin = createStudioHttpPlugin({ port: 0 });
  await plugin.start(harness.context);
  t.after(() => plugin.stop());
  assert.ok(staticFiles);
  const files = new Map([
    ['index.html', {
      body: new TextEncoder().encode('<main>console</main>'),
      contentType: 'text/html; charset=utf-8',
    }],
    ['assets/app.js', {
      body: new TextEncoder().encode('console.log("console")'),
      contentType: 'text/javascript; charset=utf-8',
      cacheControl: 'public, max-age=31536000, immutable',
    }],
  ]);
  const unregister = staticFiles.register({
    mountPath: '/',
    resolve: (relativePath) => files.get(relativePath),
    fallback: 'index.html',
  });
  const address = plugin.address();
  assert.ok(address);

  const root = await fetch(pluginUrl(address.port, '/'));
  assert.equal(root.status, 200);
  assert.equal(await root.text(), '<main>console</main>');

  const asset = await fetch(pluginUrl(address.port, '/assets/app.js'));
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(await asset.text(), 'console.log("console")');

  const clientRoute = await fetch(pluginUrl(address.port, '/tasks/next'));
  assert.equal(clientRoute.status, 200);
  assert.equal(await clientRoute.text(), '<main>console</main>');

  unregister();
  assert.equal((await fetch(pluginUrl(address.port, '/'))).status, 404);
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
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform');
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
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
