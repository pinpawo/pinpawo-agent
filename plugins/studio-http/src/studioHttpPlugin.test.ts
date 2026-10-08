import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  StudioDispatchReceipt,
  StudioDispatchRequest,
  StudioEvent,
  StudioEventHandler,
  StudioPetRegistration,
} from '@pinpawo/studio';

import {
  createStudioHttpPlugin,
  type StudioHttpPluginContext,
  type StudioHttpRoutesHook,
} from './studioHttpPlugin';

const AUTH_TOKEN = 'test-token-with-at-least-16-characters';

function receipt(request: StudioDispatchRequest): StudioDispatchReceipt {
  return {
    petId: request.petId,
    invocationId: 'invocation-1',
    ...(request.metadata ? { metadata: request.metadata } : {}),
  };
}

function createContext(options: {
  dispatch?: (request: StudioDispatchRequest) => Promise<StudioDispatchReceipt>;
  pets?: StudioPetRegistration[];
} = {}) {
  const eventHandlers = new Set<StudioEventHandler>();
  const requests: StudioDispatchRequest[] = [];
  const context: StudioHttpPluginContext = {
    dispatch: async (request) => {
      requests.push(request);
      return options.dispatch ? options.dispatch(request) : receipt(request);
    },
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
      request: 'plan this work',
      idempotencyKey: 'retry-1',
    }),
  });

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    petId: 'planner',
    invocationId: 'invocation-1',
  });
  assert.deepEqual(harness.requests, [{
    petId: 'planner',
    request: 'plan this work',
    idempotencyKey: 'retry-1',
  }]);
});

test('HTTP Plugin exposes Studio Pet registrations without Agent-private actor fields', async (t) => {
  const harness = createContext({
    pets: [{
      petId: 'planner',
      name: 'Planner',
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
    body: JSON.stringify({ petId: 'planner', request: 'x' }),
  });
  assert.equal(unauthorized.status, 401);

  const forbidden = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json',
      Origin: 'https://evil.example',
    },
    body: JSON.stringify({ petId: 'planner', request: 'x' }),
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
    body: JSON.stringify({ petId: 'missing', request: 'x' }),
  });
  assert.equal(rejected.status, 422);
  assert.deepEqual(await rejected.json(), { error: 'unknown pet' });
});

test('HTTP Plugin rejects Host-trusted session and scope fields from the wire', async (t) => {
  const harness = createContext();
  const plugin = createStudioHttpPlugin({ port: 0, authToken: AUTH_TOKEN });
  await plugin.start(harness.context);
  t.after(() => plugin.stop());
  const address = plugin.address();
  assert.ok(address);

  for (const claim of [
    { scope: { namespace: 'channel', id: 'channel-1' } },
    { session: { id: 'planner:12345678' } },
    { session: { id: 'planner:12345678', create: true }, scope: { namespace: 'channel', id: 'channel-1' } },
  ]) {
    const response: Response = await fetch(pluginUrl(address.port, '/dispatch'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ petId: 'planner', request: 'publish elsewhere', ...claim }),
    });
    assert.equal(response.status, 400);
  }
  assert.deepEqual(harness.requests, []);
});

test('HTTP Plugin dispatches contributed routes through its shared Hono middleware', async (t) => {
  const harness = createContext();
  let routes: StudioHttpRoutesHook | undefined;
  harness.context.hooks = {
    expose: (hookName, hook) => {
      assert.equal(hookName, 'routes');
      routes = hook as StudioHttpRoutesHook;
      return () => {
        routes = undefined;
      };
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

test('HTTP Plugin allows an explicitly route-authenticated external endpoint', async (t) => {
  const harness = createContext();
  let routes: StudioHttpRoutesHook | undefined;
  harness.context.hooks = {
    expose: (_hookName, hook) => {
      routes = hook as StudioHttpRoutesHook;
      return () => { routes = undefined; };
    },
    contribute: () => () => undefined,
  };
  const plugin = createStudioHttpPlugin({ port: 0, authToken: AUTH_TOKEN });
  await plugin.start(harness.context);
  t.after(() => plugin.stop());
  assert.ok(routes);
  routes.register({
    method: 'POST',
    path: '/external-hook',
    authorization: 'route',
    handle: ({ headers }) => headers.authorization === 'Trigger external-secret'
      ? { kind: 'json', status: 202, body: { accepted: true } }
      : { kind: 'json', status: 401, body: { error: 'Unauthorized.' } },
  });
  const address = plugin.address();
  assert.ok(address);

  const accepted = await fetch(pluginUrl(address.port, '/external-hook'), {
    method: 'POST',
    headers: { Authorization: 'Trigger external-secret' },
  });
  assert.equal(accepted.status, 202);
  const rejected = await fetch(pluginUrl(address.port, '/external-hook'), { method: 'POST' });
  assert.equal(rejected.status, 401);

  const management = await fetch(pluginUrl(address.port, '/pets'));
  assert.equal(management.status, 401);
});

test('HTTP Plugin gives a route the exact request text for signature verification', async (t) => {
  const harness = createContext();
  let routes: StudioHttpRoutesHook | undefined;
  harness.context.hooks = {
    expose: (_hookName, hook) => {
      routes = hook as StudioHttpRoutesHook;
      return () => { routes = undefined; };
    },
    contribute: () => () => undefined,
  };
  const plugin = createStudioHttpPlugin({ port: 0, authToken: AUTH_TOKEN });
  await plugin.start(harness.context);
  t.after(() => plugin.stop());
  assert.ok(routes);
  routes.register({
    method: 'POST',
    path: '/signed-hook',
    authorization: 'route',
    handle: async ({ readText }) => ({ kind: 'text', body: await readText() }),
  });
  const address = plugin.address();
  assert.ok(address);

  const payload = '{"z":1, "a":[true,false]}';
  const response = await fetch(pluginUrl(address.port, '/signed-hook'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), payload);
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
    source: 'example-work',
    payload: { taskId: 'task-1' },
    occurredAt: '2026-08-23T00:00:00.000Z',
  };
  await harness.emit(event);
  const stream = await readStreamUntil(reader, (text) => text.includes('task.done'));
  assert.match(stream, /event: studio\.event/);
  assert.match(stream, /"source":"example-work"/);

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

function sessionHarness() {
  const harness = createContext();
  const reviews: unknown[] = [];
  const listeners = new Set<(message: unknown) => void>();
  const snapshot = { version: 5, session: { sessionId: 'pet:0000000b', kind: 'chat', timeline: [], activeRun: null, pendingInterrupt: null } };
  const notFound = (sessionId: string) => Object.assign(new Error(`no ${sessionId}`), { code: 'session_not_found' });
  harness.context.petSessions = {
    snapshot: async (_petId, sessionId) => {
      if (sessionId !== 'pet:0000000b') throw notFound(sessionId);
      return snapshot as never;
    },
    observe: async (_petId, sessionId, listener) => {
      if (sessionId !== 'pet:0000000b') throw notFound(sessionId);
      listener({ type: 'session.snapshot.result', requestId: 'first', snapshot } as never);
      const forward = (message: unknown) => listener(message as never);
      listeners.add(forward);
      return () => { listeners.delete(forward); };
    },
    review: async (petId, sessionId, request) => {
      if (sessionId !== 'pet:0000000b') throw notFound(sessionId);
      if (request.requestId === 'busy' || request.requestId === 'closed') {
        throw Object.assign(new Error(`refused: ${request.requestId}`), {
          code: request.requestId === 'busy' ? 'session_busy' : 'review_closed',
        });
      }
      reviews.push({ petId, sessionId, request });
    },
  };
  return { harness, reviews, listeners, publish: (message: unknown) => { for (const listener of listeners) listener(message); } };
}

test('HTTP Plugin reads and follows one exact Pet session', async (t) => {
  const { harness, listeners, publish } = sessionHarness();
  const plugin = createStudioHttpPlugin({ port: 0, authToken: AUTH_TOKEN });
  await plugin.start(harness.context);
  t.after(() => plugin.stop());
  const address = plugin.address();
  assert.ok(address);
  const headers = { Authorization: `Bearer ${AUTH_TOKEN}` };

  const snapshot = await fetch(pluginUrl(address.port, '/pet-sessions/snapshot?petId=pet&sessionId=pet%3A0000000b'), { headers });
  assert.equal(snapshot.status, 200);
  assert.equal((await snapshot.json()).snapshot.session.sessionId, 'pet:0000000b');

  const missing = await fetch(pluginUrl(address.port, '/pet-sessions/snapshot?petId=pet&sessionId=pet%3Adeadbeef'), { headers });
  assert.equal(missing.status, 404);
  const incomplete = await fetch(pluginUrl(address.port, '/pet-sessions/snapshot?petId=pet'), { headers });
  assert.equal(incomplete.status, 400);
  const unknownStream = await fetch(pluginUrl(address.port, '/pet-sessions/events?petId=pet&sessionId=pet%3Adeadbeef'), { headers });
  assert.equal(unknownStream.status, 404);

  const abort = new AbortController();
  const stream = await fetch(pluginUrl(address.port, '/pet-sessions/events?petId=pet&sessionId=pet%3A0000000b'), { headers, signal: abort.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  const first = await readStreamUntil(reader, (text) => text.includes('session.snapshot.result'));
  assert.match(first, /event: agent\.session/);
  publish({ type: 'event', requestId: 'r1', event: { type: 'run.started', requestId: 'r1', initiator: 'host' } });
  const next = await readStreamUntil(reader, (text) => text.includes('run.started'));
  assert.match(next, /"requestId":"r1"/);
  abort.abort();
  await reader.cancel().catch(() => undefined);
  for (let attempt = 0; attempt < 100 && listeners.size; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(listeners.size, 0);
});

test('HTTP Plugin accepts only a review answer for an exact Pet session', async (t) => {
  const { harness, reviews } = sessionHarness();
  const plugin = createStudioHttpPlugin({ port: 0, authToken: AUTH_TOKEN });
  await plugin.start(harness.context);
  t.after(() => plugin.stop());
  const address = plugin.address();
  assert.ok(address);
  const post = (body: unknown) => fetch(pluginUrl(address.port, '/pet-sessions/review'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const answer = {
    petId: 'pet', sessionId: 'pet:0000000b', requestId: 'review-1', interruptId: 'interrupt-1',
    value: { decisions: [{ interactionId: 'review-1', selectedOptionId: 'approve', input: { message: 'ok' } }] },
  };

  const accepted = await post(answer);
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { requestId: 'review-1' });
  assert.deepEqual(reviews, [{
    petId: 'pet', sessionId: 'pet:0000000b',
    request: { requestId: 'review-1', interruptId: 'interrupt-1', value: answer.value },
  }]);

  for (const body of [
    { ...answer, type: 'chat_request', message: 'hi' },
    { ...answer, value: { action: 'cancel' } },
    { ...answer, value: { decisions: [] } },
    { ...answer, value: { decisions: [{ interactionId: 'review-1' }] } },
    { petId: 'pet', sessionId: 'pet:0000000b', type: 'session.resume', requestId: 'x' },
  ]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await post({ ...answer, sessionId: 'pet:deadbeef' })).status, 404);
  // A refused answer is told now, with the Host's reason, instead of a 202.
  for (const requestId of ['busy', 'closed']) {
    const refused = await post({ ...answer, requestId });
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: `refused: ${requestId}` });
  }
  assert.equal(reviews.length, 1);
});

test('HTTP Plugin reports session access as unavailable without a session port', async (t) => {
  const harness = createContext();
  const plugin = createStudioHttpPlugin({ port: 0, authToken: AUTH_TOKEN });
  await plugin.start(harness.context);
  t.after(() => plugin.stop());
  const address = plugin.address();
  assert.ok(address);
  const response = await fetch(pluginUrl(address.port, '/pet-sessions/snapshot?petId=pet&sessionId=s'), {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  });
  assert.equal(response.status, 503);
});
