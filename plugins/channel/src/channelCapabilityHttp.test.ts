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

import { createChannelPlugin } from './channelPlugin';

const HOST_TOKEN = 'host-token-with-at-least-16-characters';
const SESSION_TOKEN = 'session-token-for-ada';
const USER_CLIENT_ID = 'user.ada';

/**
 * Channel routes declare `channel.read` / `channel.write`. A `pps_` key or a
 * JWT holds both by default, so the only credential that can be narrowed is a
 * login session — this is the regression guard for that narrowing, driven
 * through the real HTTP Plugin and the real hook registry.
 */
async function harness(options: { pets?: Array<{ petId: string; name: string }> } = {}) {
  const pets = options.pets ?? [];
  const dispatches: Array<{ petId: string; request: string }> = [];
  const storage = createStudioStorage({ kind: 'sqlite', path: ':memory:' });
  const clients = new StudioClients(async () => new KyselyClientStore(
    await storage.open<ClientDatabase>('clients', clientMigrations),
  ));
  await clients.ensure({ clientId: USER_CLIENT_ID, label: 'ada' });
  const registry = new StudioPluginHookRegistry();

  const http = createStudioHttpPlugin({ port: 0, authToken: HOST_TOKEN });
  await http.start({
    dispatch: async () => { throw new Error('not used'); },
    subscribe: () => () => undefined,
    listPets: () => [],
    clients,
    hooks: registry.contextFor('http'),
  });

  // The login Plugin's verifier, reduced to what this test needs: a credential
  // that resolves to a client-scope principal carrying named capabilities.
  let capabilities: readonly string[] = ['studio.view'];
  registry.contextFor('login').contribute('http', 'authenticators', (hook) => (
    hook as { register: (authenticator: {
      verify: (token: string) => Promise<{ clientId: string; scope: 'client'; capabilities: readonly string[] } | undefined>;
    }) => () => void }
  ).register({
    verify: async (token) => (token === SESSION_TOKEN
      ? { clientId: USER_CLIENT_ID, scope: 'client' as const, capabilities }
      : undefined),
  }));

  const channel = createChannelPlugin();
  await channel.start({
    dispatch: async (request) => {
      dispatches.push({ petId: request.petId, request: request.request });
      return { petId: request.petId, invocationId: `invocation-${dispatches.length}` };
    },
    registerContextProvider: () => () => undefined,
    allocateSessionId: () => 'unused',
    notify: () => undefined,
    subscribe: () => () => undefined,
    listPets: () => pets.map(pet => ({ ...pet, definitionId: pet.petId })),
    pets: {} as StudioPluginContext['pets'],
    listDispatchQueues: () => [],
    petSessions: {} as StudioPluginContext['petSessions'],
    hooks: registry.contextFor('channel'),
    storage: { dialect: 'sqlite', open: (migrations) => storage.open('channel', migrations) },
    clients,
    models: { resolve: () => { throw new Error('not used'); } } as unknown as StudioPluginContext['models'],
  });

  const address = http.address();
  assert.ok(address, 'the HTTP Plugin exposes an address');
  const base = `http://127.0.0.1:${address.port.toString()}`;

  async function call(
    method: 'GET' | 'POST',
    path: string,
    input: { token?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers: Record<string, string> = {};
    if (input.token) headers.authorization = `Bearer ${input.token}`;
    if (input.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
  }

  return {
    clients,
    call,
    dispatches,
    grant: (next: readonly string[]) => { capabilities = next; },
    stop: async () => {
      await channel.stop?.();
      await http.stop();
      await storage.close();
    },
  };
}

test('a login session without channel.read cannot read Channels', async (t) => {
  const h = await harness();
  t.after(h.stop);

  const denied = await h.call('GET', '/channels', { token: SESSION_TOKEN });
  assert.equal(denied.status, 403);
  assert.match(String(denied.body.error), /channel\.read/);
});

test('a login session without channel.write cannot create a Channel', async (t) => {
  const h = await harness();
  t.after(h.stop);

  h.grant(['channel.read']);
  assert.equal((await h.call('GET', '/channels', { token: SESSION_TOKEN })).status, 200);

  const denied = await h.call('POST', '/channels', {
    token: SESSION_TOKEN,
    body: { title: 'Release', pets: [] },
  });
  assert.equal(denied.status, 403);
  assert.match(String(denied.body.error), /channel\.write/);
});

test('granting both Channel capabilities opens reads and writes', async (t) => {
  const h = await harness();
  t.after(h.stop);

  h.grant(['channel.read', 'channel.write']);
  assert.equal((await h.call('GET', '/channels', { token: SESSION_TOKEN })).status, 200);
  const created = await h.call('POST', '/channels', {
    token: SESSION_TOKEN,
    body: { title: 'Release', pets: [] },
  });
  assert.equal(created.status, 201);
});

test('a pps_ key keeps the Channel reach it had before capabilities', async (t) => {
  const h = await harness();
  t.after(h.stop);
  const { key } = await h.clients.create({ clientId: 'svc', label: 'service' });

  assert.equal((await h.call('GET', '/channels', { token: key })).status, 200);
  const created = await h.call('POST', '/channels', {
    token: key,
    body: { title: 'From a key', pets: [] },
  });
  assert.equal(created.status, 201);
});

test('the local Host token keeps full Channel access', async (t) => {
  const h = await harness();
  t.after(h.stop);

  assert.equal((await h.call('GET', '/channels', { token: HOST_TOKEN })).status, 200);
  assert.equal((await h.call('POST', '/channels', {
    token: HOST_TOKEN,
    body: { title: 'From the Host', pets: [] },
  })).status, 201);
});

/**
 * The deliberate split recorded in `docs/design/studio/user-auth.md` §3.5.1:
 * `studio.dispatch` gates the direct `POST /dispatch` route only, while running
 * a Pet from inside a Channel is gated by `channel.write` plus membership. These
 * two tests pin that semantic so it cannot drift silently in either direction.
 */
test('channel.write starts a Pet from a Channel without studio.dispatch', async (t) => {
  const h = await harness({ pets: [{ petId: 'executor', name: 'Executor' }] });
  t.after(h.stop);
  h.grant(['channel.read', 'channel.write', 'studio.view']);

  const created = await h.call('POST', '/channels', {
    token: SESSION_TOKEN,
    body: { title: 'Release', pets: ['executor'] },
  });
  assert.equal(created.status, 201);
  const channelId = (created.body.channel as { channelId: string }).channelId;

  const posted = await h.call('POST', '/channels/messages', {
    token: SESSION_TOKEN,
    body: {
      channelId,
      body: 'Please take this one.',
      mentions: [{ participantId: 'pet:executor' }],
    },
  });
  assert.equal(posted.status, 201);
  const deliveries = posted.body.deliveries as Array<{ state: string; participantId: string }>;
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.state, 'accepted');
  assert.equal(deliveries[0]!.participantId, 'pet:executor');

  // The Pet really ran: the Channel dispatched it with the Channel scope.
  assert.equal(h.dispatches.length, 1);
  assert.equal(h.dispatches[0]!.petId, 'executor');

  // The same session still cannot use the direct dispatch route.
  const direct = await h.call('POST', '/dispatch', {
    token: SESSION_TOKEN,
    body: { petId: 'executor', request: 'direct' },
  });
  assert.equal(direct.status, 403);
  assert.match(String(direct.body.error), /studio\.dispatch/);
});

test('without channel.write a login session cannot start a Pet from a Channel', async (t) => {
  const h = await harness({ pets: [{ petId: 'executor', name: 'Executor' }] });
  t.after(h.stop);
  h.grant(['channel.read', 'studio.view']);

  const denied = await h.call('POST', '/channels', {
    token: SESSION_TOKEN,
    body: { title: 'Release', pets: ['executor'] },
  });
  assert.equal(denied.status, 403);
  assert.match(String(denied.body.error), /channel\.write/);
  assert.equal(h.dispatches.length, 0);
});
