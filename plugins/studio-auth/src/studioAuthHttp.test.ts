import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KyselyClientStore,
  StudioClients,
  StudioPluginHookRegistry,
  clientMigrations,
  createStudioStorage,
  type ClientDatabase,
  type StudioPluginContext,
  type StudioEvent,
  type StudioEventHandler,
} from '@pinpawo/studio-core';
import { createStudioHttpPlugin } from '@pinpawo-plugin/studio-http';

import { createStudioAuthPlugin } from './studioAuthPlugin';
import type { StudioAuthDatabase } from './repository';

const HOST_TOKEN = 'host-token-with-at-least-16-characters';
const SECRET = 'test-secret-with-at-least-32-characters';
const PASSWORD = 'correct-horse-battery-staple';

/**
 * A login Plugin and a real HTTP Plugin, wired through the real hook registry:
 * this is the wiring a Studio Host performs, and the only one that exercises
 * route registration end to end.
 */
async function harness(
  startOrder: 'http-first' | 'auth-first' = 'http-first',
  options: { heartbeatIntervalMs?: number; afterObserve?: () => Promise<void> } = {},
) {
  const storage = createStudioStorage({ kind: 'sqlite', path: ':memory:' });
  const clients = new StudioClients(async () => new KyselyClientStore(
    await storage.open<ClientDatabase>('clients', clientMigrations),
  ));
  const registry = new StudioPluginHookRegistry();

  const eventListeners = new Set<StudioEventHandler>();
  const sessionListeners = new Set<(message: unknown) => void>();
  const snapshot = { version: 1, session: { sessionId: 'pet:0000000b', kind: 'chat', timeline: [], activeRun: null, pendingInterrupt: null } };
  const petSessions: StudioPluginContext['petSessions'] = {
    snapshot: async () => snapshot as never,
    observe: async (_petId, _sessionId, listener) => {
      listener({ type: 'session.snapshot.result', requestId: 'first', snapshot } as never);
      const forward = (message: unknown) => listener(message as never);
      sessionListeners.add(forward);
      await options.afterObserve?.();
      return () => { sessionListeners.delete(forward); };
    },
    review: async () => undefined,
  };
  const subscribe: StudioPluginContext['subscribe'] = (listener) => {
    eventListeners.add(listener);
    return () => { eventListeners.delete(listener); };
  };
  const http = createStudioHttpPlugin({
    port: 0, authToken: HOST_TOKEN, heartbeatIntervalMs: options.heartbeatIntervalMs ?? 60_000,
  });
  const auth = createStudioAuthPlugin({ secret: SECRET });
  const authContext: StudioPluginContext = {
    dispatch: async () => { throw new Error('not used'); },
    registerContextProvider: () => () => undefined,
    allocateSessionId: () => 'unused',
    notify: () => undefined,
    subscribe,
    petSessions,
    listPets: () => [],
    pets: {} as StudioPluginContext['pets'],
    listDispatchQueues: () => [],
    hooks: registry.contextFor('studio-auth'),
    storage: {
      dialect: storage.dialect,
      open: (migrations) => storage.open('studio_auth', migrations),
    },
    clients,
    models: { resolve: () => { throw new Error('not used'); } } as unknown as StudioPluginContext['models'],
  };

  if (startOrder === 'http-first') await http.start({
    dispatch: async (request) => ({ petId: request.petId, invocationId: 'invocation-1' }),
    subscribe,
    petSessions,
    listPets: () => [],
    clients,
    hooks: registry.contextFor('http'),
  });
  await auth.start(authContext);
  if (startOrder === 'auth-first') await http.start({
    dispatch: async (request) => ({ petId: request.petId, invocationId: 'invocation-1' }),
    subscribe,
    petSessions,
    listPets: () => [],
    clients,
    hooks: registry.contextFor('http'),
  });

  const address = http.address();
  assert.ok(address, 'the HTTP Plugin exposes an address');
  const base = `http://127.0.0.1:${address.port.toString()}`;

  async function call(
    method: 'GET' | 'POST',
    path: string,
    input: { token?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = {};
    if (input.token) headers.authorization = `Bearer ${input.token}`;
    if (input.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) as unknown : null };
  }

  async function createUser(username: string): Promise<string> {
    const created = await call('POST', '/users', {
      token: HOST_TOKEN,
      body: { username, password: PASSWORD },
    });
    assert.equal(created.status, 201);
    return (created.body as { userId: string }).userId;
  }

  async function login(username: string): Promise<string> {
    const signedIn = await call('POST', '/auth/login', { body: { username, password: PASSWORD } });
    assert.equal(signedIn.status, 200);
    return (signedIn.body as { token: string }).token;
  }

  return {
    http,
    auth,
    clients,
    storage,
    registry,
    base,
    call,
    createUser,
    login,
    sessionListeners,
    emitEvent: async (event: StudioEvent) => {
      for (const listener of eventListeners) await listener(event);
    },
    emitSession: (message: unknown) => {
      for (const listener of sessionListeners) listener(message);
    },
    inspect: () => storage.open<StudioAuthDatabase>('inspector', {}),
    stop: async () => {
      await auth.stop();
      await http.stop();
      await storage.close();
    },
  };
}

test('the real HTTP Plugin serves the login routes it used to reject as reserved', async (t) => {
  const h = await harness();
  t.after(h.stop);

  await h.createUser('ada');
  const token = await h.login('ada');

  const me = await h.call('GET', '/auth/me', { token });
  assert.equal(me.status, 200);
  assert.deepEqual(me.body, {
    userId: (me.body as { userId: string }).userId,
    username: 'ada',
    clientId: 'user.ada',
    displayName: 'ada',
    capabilities: ['channel.read', 'channel.write', 'studio.view'],
    expiresAt: (me.body as { expiresAt: string }).expiresAt,
  });

  // A session token is a Studio client credential now: the built-in routes see it.
  const pets = await h.call('GET', '/pets', { token });
  assert.equal(pets.status, 200);

  // The Host token still answers exactly what it always did.
  const host = await h.call('GET', '/me', { token: HOST_TOKEN });
  assert.deepEqual(host.body, { clientId: 'local', scope: 'studio' });

  assert.equal((await h.call('GET', '/pets')).status, 401);
  assert.equal((await h.call('POST', '/auth/logout', { token })).status, 204);
  assert.equal((await h.call('GET', '/auth/me', { token })).status, 401);
});

test('the same wiring works when the login Plugin starts first', async (t) => {
  const h = await harness('auth-first');
  t.after(h.stop);
  await h.createUser('grace');
  const token = await h.login('grace');
  assert.equal((await h.call('GET', '/auth/me', { token })).status, 200);
});

test('a user reaches only the routes their capabilities allow', async (t) => {
  const h = await harness();
  t.after(h.stop);
  const userId = await h.createUser('margaret');
  const token = await h.login('margaret');

  const denied = await h.call('POST', '/dispatch', {
    token,
    body: { petId: 'planner', request: 'plan this work', idempotencyKey: 'retry-1' },
  });
  assert.equal(denied.status, 403);
  assert.match((denied.body as { error: string }).error, /studio\.dispatch/);

  const granted = await h.call('POST', '/users/capabilities', {
    token: HOST_TOKEN,
    body: { userId, capabilities: ['studio.view', 'studio.dispatch'] },
  });
  assert.equal(granted.status, 200);

  const accepted = await h.call('POST', '/dispatch', {
    token,
    body: { petId: 'planner', request: 'plan this work', idempotencyKey: 'retry-1' },
  });
  assert.equal(accepted.status, 202);
});

test('a pps_ key keeps the reach and the message it had before capabilities', async (t) => {
  const h = await harness();
  t.after(h.stop);
  const { key } = await h.clients.create({ clientId: 'svc', label: 'service' });

  assert.equal((await h.call('GET', '/pets', { token: key })).status, 200);
  const denied = await h.call('POST', '/dispatch', {
    token: key,
    body: { petId: 'planner', request: 'plan this work', idempotencyKey: 'retry-1' },
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.body, { error: 'This client may not use this route.' });
  assert.deepEqual((await h.call('GET', '/me', { token: key })).body, {
    clientId: 'svc',
    scope: 'client',
  });
});

test('an expired session is refused at the HTTP layer', async (t) => {
  const h = await harness();
  t.after(h.stop);
  await h.createUser('barbara');
  const token = await h.login('barbara');

  const db = await h.inspect();
  await db.updateTable('studio_auth_session')
    .set({ expires_at: new Date(Date.now() - 1_000).toISOString() })
    .execute();
  assert.equal((await h.call('GET', '/auth/me', { token })).status, 401);
  assert.equal((await h.call('GET', '/pets', { token })).status, 401);
});

test('a verifying Plugin that throws answers 401, not 500', async (t) => {
  const h = await harness();
  t.after(h.stop);

  await h.createUser('edsger');
  const token = await h.login('edsger');
  // Another Plugin claims every credential it is shown and then falls over.
  h.registry.contextFor('broken-plugin').contribute(
    'http',
    'authenticators',
    (hook) => (hook as { register: (authenticator: { verify: () => Promise<never> }) => () => void })
      .register({ verify: async () => { throw new Error('verifier exploded'); } }),
  );

  // A login session still resolves, because the login verifier answers first.
  assert.equal((await h.call('GET', '/auth/me', { token })).status, 200);
  // An unknown credential is a 401, not a 500 leaking an internal failure.
  const unknown = await h.call('GET', '/pets', { token: 'not-a-known-credential-value' });
  assert.equal(unknown.status, 401);
});

test('a malformed login request keeps its 400/415 contract instead of a 500', async (t) => {
  const h = await harness();
  t.after(h.stop);

  const malformed = await fetch(`${h.base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'Request body must contain valid JSON.' });

  const wrongType = await fetch(`${h.base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{"username":"ada","password":"irrelevant"}',
  });
  assert.equal(wrongType.status, 415);
  assert.deepEqual(await wrongType.json(), { error: 'Content-Type must be application/json.' });

  // The administrator routes read a body the same way, so they answer alike.
  const users = await fetch(`${h.base}/users`, {
    method: 'POST',
    headers: { authorization: `Bearer ${HOST_TOKEN}`, 'content-type': 'application/json' },
    body: '{"username":',
  });
  assert.equal(users.status, 400);
  assert.deepEqual(await users.json(), { error: 'Request body must contain valid JSON.' });
});

test('a real login is audited with the address the connection came from', async (t) => {
  const h = await harness();
  t.after(h.stop);
  await h.createUser('hopper');

  const response = await fetch(`${h.base}/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '10.0.0.9',
    },
    body: JSON.stringify({ username: 'hopper', password: PASSWORD }),
  });
  assert.equal(response.status, 200);

  const db = await h.inspect();
  const rows = await db.selectFrom('studio_auth_audit').selectAll().execute();
  const login = rows.find((row) => row.action === 'login' && row.result === 'ok');
  // The loopback socket address, not the header: nothing is trusted in front.
  assert.equal(login?.remote_addr, '127.0.0.1');
});


/** Bound every stream read so a failed revocation cannot hang the suite. */
function streamReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let buffered = '';
  const decoder = new TextDecoder();
  async function readUntil(predicate: (text: string) => boolean, toEnd = false): Promise<string> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        (async () => {
          while (true) {
            if (!toEnd && predicate(buffered)) {
              const result = buffered;
              buffered = '';
              return result;
            }
            const next = await reader.read();
            if (next.done) {
              assert.ok(toEnd || predicate(buffered), 'stream closed before the expected event');
              return buffered;
            }
            buffered += decoder.decode(next.value, { stream: true });
          }
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('SSE read did not finish within 3 seconds')), 3_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return {
    until: (marker: string) => readUntil((text) => text.includes(marker)),
    end: () => readUntil(() => false, true),
  };
}

const sessionEventsPath = '/pet-sessions/events?petId=pet&sessionId=pet%3A0000000b';
for (const path of ['/events', sessionEventsPath]) {
  for (const invalidation of ['logout', 'admin disable', 'capability removal', 'client revocation', 'password reset', 'absolute expiry']) {
    test(`real login session SSE ${path} closes after ${invalidation}`, async (t) => {
      const h = await harness('http-first', {
        heartbeatIntervalMs: invalidation === 'absolute expiry' ? 20 : 60_000,
      });
      const controller = new AbortController();
      t.after(async () => { controller.abort(); await h.stop(); });
      const userId = await h.createUser('stream-reader');
      assert.equal((await h.call('POST', '/users/capabilities', {
        token: HOST_TOKEN, body: { userId, capabilities: ['studio.events', 'pet.session'] },
      })).status, 200);
      const token = await h.login('stream-reader');
      const response = await fetch(`${h.base}${path}${path.includes('?') ? '&' : '?'}heartbeat=1`, {
        headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
      });
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      const stream = streamReader(reader);
      await stream.until(path === '/events' ? ': connected' : 'session.snapshot.result');
      const emit = async (marker: string) => {
        if (path === '/events') {
          await h.emitEvent({ eventId: marker, type: 'test.event', source: 'test', payload: { marker }, occurredAt: new Date().toISOString() });
        } else {
          h.emitSession({ type: 'session.snapshot.result', requestId: marker, snapshot: { marker } });
        }
      };
      await emit('visible-before-invalidation');
      await stream.until('visible-before-invalidation');

      if (invalidation === 'logout') {
        assert.equal((await h.call('POST', '/auth/logout', { token })).status, 204);
      } else if (invalidation === 'admin disable') {
        assert.equal((await h.call('POST', '/users/disable', {
          token: HOST_TOKEN, body: { userId, disabled: true },
        })).status, 200);
      } else if (invalidation === 'capability removal') {
        assert.equal((await h.call('POST', '/users/capabilities', {
          token: HOST_TOKEN, body: { userId, capabilities: ['channel.read'] },
        })).status, 200);
      } else if (invalidation === 'client revocation') {
        assert.equal((await h.call('POST', '/clients/revoke', {
          token: HOST_TOKEN, body: { clientId: 'user.stream-reader' },
        })).status, 200);
      } else if (invalidation === 'password reset') {
        assert.equal((await h.call('POST', '/users/password', {
          token: HOST_TOKEN, body: { userId, password: 'replacement-password-for-stream' },
        })).status, 204);
      } else {
        // Move the persisted absolute deadline behind now without sleeping or
        // replacing the verifier. The next client heartbeat must discover the expiry.
        const db = await h.inspect();
        await db.updateTable('studio_auth_session')
          .set({ expires_at: new Date(Date.now() - 1_000).toISOString() }).execute();
      }
      const streamId = response.headers.get('x-studio-stream-id');
      assert.ok(streamId);
      assert.equal((await h.call('GET', `/me?streamId=${streamId}`, { token })).status, invalidation === 'capability removal' ? 403 : 401);
      await emit('secret-after-invalidation');
      const remaining = await stream.end();
      assert.ok(!remaining.includes('secret-after-invalidation'), remaining);
      assert.equal(h.sessionListeners.size, 0, 'the Pet session observer is released');
      await emit('secret-after-close');
      assert.equal((await reader.read()).done, true);
      assert.equal((await h.call('GET', '/me', { token: HOST_TOKEN })).status, 200);
    });
  }
}

test('real logout during observation attachment suppresses the buffered session snapshot', async (t) => {
  let logout: (() => Promise<void>) | undefined;
  const h = await harness('http-first', { afterObserve: async () => logout?.() });
  const controller = new AbortController();
  t.after(async () => { controller.abort(); await h.stop(); });
  const userId = await h.createUser('snapshot-reader');
  assert.equal((await h.call('POST', '/users/capabilities', {
    token: HOST_TOKEN, body: { userId, capabilities: ['pet.session'] },
  })).status, 200);
  const token = await h.login('snapshot-reader');
  logout = async () => {
    assert.equal((await h.call('POST', '/auth/logout', { token })).status, 204);
  };
  const response = await fetch(`${h.base}${sessionEventsPath}&heartbeat=1`, {
    headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
  });
  assert.equal(response.status, 401);
  assert.ok(!(await response.text()).includes('session.snapshot.result'));
  assert.equal(h.sessionListeners.size, 0);
});

test('a slow in-flight heartbeat must not extend authorization beyond 15 seconds after revocation', async (t) => {
  const now = Date.now();
  let clock = now;
  const originalNow = Date.now;
  Date.now = () => clock;
  const h = await harness('http-first', { heartbeatIntervalMs: 60_000 });
  const controller = new AbortController();
  t.after(async () => { Date.now = originalNow; controller.abort(); await h.stop(); });
  const userId = await h.createUser('lease-race');
  assert.equal((await h.call('POST', '/users/capabilities', {
    token: HOST_TOKEN, body: { userId, capabilities: ['studio.events'] },
  })).status, 200);
  const token = await h.login('lease-race');
  const response = await fetch(`${h.base}/events?heartbeat=1`, {
    headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
  });
  const stream = streamReader(response.body!.getReader());
  await stream.until(': connected');
  const streamId = response.headers.get('X-Studio-Stream-Id');
  let release!: () => void;
  const hold = new Promise<void>(resolve => release = resolve);
  let entered!: () => void;
  const blocked = new Promise<void>(resolve => entered = resolve);
  const originalGet = h.clients.get.bind(h.clients);
  let armed = true;
  h.clients.get = async (...args) => {
    const client = await originalGet(...args);
    if (armed && args[0] === 'user.lease-race') { armed = false; entered(); await hold; }
    return client;
  };
  const renewing = h.call('GET', `/me?streamId=${streamId}`, { token });
  await blocked;
  assert.equal((await h.call('POST', '/auth/logout', { token })).status, 204);
  clock = now + 14_000;
  release();
  const result = await renewing;
  assert.equal(result.status, 200, 'a verified in-flight request may finish within the original lease');
  clock = now + 16_000;
  const marker = 'secret-16-seconds-after-logout';
  await h.emitEvent({eventId:marker,type:'test.event',source:'test',payload:{marker},occurredAt:new Date(clock).toISOString()});
  const received = await stream.end();
  assert.ok(!received.includes(marker), 'stale auth result extended the revocation window beyond 15 seconds');
});


test('canceling a local-token request while observation attaches releases its observer', async (t) => {
  let attached!: () => void;
  const observing = new Promise<void>(resolve => { attached = resolve; });
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const h = await harness('http-first', { afterObserve: async () => { attached(); await hold; } });
  const controller = new AbortController();
  t.after(async () => { release(); controller.abort(); await h.stop(); });
  const pending = fetch(`${h.base}${sessionEventsPath}`, {
    headers: { Authorization: `Bearer ${HOST_TOKEN}` }, signal: controller.signal,
  }).then(() => assert.fail('canceled before the response'), error => assert.equal(error.name, 'AbortError'));
  await observing;
  controller.abort();
  await pending;
  release();
  for (let i = 0; i < 50 && h.sessionListeners.size; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.sessionListeners.size, 0);
});
