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
async function harness(startOrder: 'http-first' | 'auth-first' = 'http-first') {
  const storage = createStudioStorage({ kind: 'sqlite', path: ':memory:' });
  const clients = new StudioClients(async () => new KyselyClientStore(
    await storage.open<ClientDatabase>('clients', clientMigrations),
  ));
  const registry = new StudioPluginHookRegistry();

  const http = createStudioHttpPlugin({ port: 0, authToken: HOST_TOKEN });
  const auth = createStudioAuthPlugin({ secret: SECRET });
  const authContext: StudioPluginContext = {
    dispatch: async () => { throw new Error('not used'); },
    registerContextProvider: () => () => undefined,
    allocateSessionId: () => 'unused',
    notify: () => undefined,
    subscribe: () => () => undefined,
    listPets: () => [],
    pets: {} as StudioPluginContext['pets'],
    listDispatchQueues: () => [],
    petSessions: {} as StudioPluginContext['petSessions'],
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
    subscribe: () => () => undefined,
    listPets: () => [],
    clients,
    hooks: registry.contextFor('http'),
  });
  await auth.start(authContext);
  if (startOrder === 'auth-first') await http.start({
    dispatch: async (request) => ({ petId: request.petId, invocationId: 'invocation-1' }),
    subscribe: () => () => undefined,
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
    call,
    createUser,
    login,
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
