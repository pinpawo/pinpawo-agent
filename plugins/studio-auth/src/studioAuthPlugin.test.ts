import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KyselyClientStore,
  StudioClients,
  clientMigrations,
  createStudioStorage,
  type ClientDatabase,
  type StudioPluginContext,
} from '@pinpawo/studio-core';
import type {
  StudioHttpAuthenticator,
  StudioHttpAuthenticatorsHook,
  StudioHttpRoute,
  StudioHttpRouteRequest,
  StudioHttpRoutesHook,
} from '@pinpawo-plugin/studio-http';

import { createStudioAuthPlugin, type CreateStudioAuthPluginOptions } from './studioAuthPlugin';
import type { StudioAuthDatabase } from './repository';

const SECRET = 'test-secret-with-at-least-32-characters';
const PASSWORD = 'correct-horse-battery-staple';

/**
 * A Plugin running against a throwaway SQLite database, with the two HTTP
 * extension points it consumes captured instead of attached to a live server.
 */
async function harness(options: CreateStudioAuthPluginOptions = {}) {
  const storage = createStudioStorage({ kind: 'sqlite', path: ':memory:' });
  const clients = new StudioClients(async () => new KyselyClientStore(
    await storage.open<ClientDatabase>('clients', clientMigrations),
  ));
  const routes = new Map<string, StudioHttpRoute>();
  const authenticators = new Set<StudioHttpAuthenticator>();
  const contributions: string[] = [];

  const context: StudioPluginContext = {
    dispatch: async () => { throw new Error('not used'); },
    registerContextProvider: () => () => undefined,
    allocateSessionId: () => 'unused',
    notify: () => undefined,
    subscribe: () => () => undefined,
    listPets: () => [],
    pets: {} as StudioPluginContext['pets'],
    listDispatchQueues: () => [],
    petSessions: {} as StudioPluginContext['petSessions'],
    hooks: {
      expose: () => () => undefined,
      contribute: ((target: string, hookName: string, install: (hook: unknown) => () => void) => {
        contributions.push(`${target}:${hookName}`);
        if (hookName === 'routes') {
          const hook: StudioHttpRoutesHook = {
            register: (route) => {
              routes.set(`${route.method} ${route.path}`, route);
              return () => routes.delete(`${route.method} ${route.path}`);
            },
          };
          return install(hook);
        }
        if (hookName === 'authenticators') {
          const hook: StudioHttpAuthenticatorsHook = {
            register: (authenticator) => {
              authenticators.add(authenticator);
              return () => authenticators.delete(authenticator);
            },
          };
          return install(hook);
        }
        throw new Error(`Studio auth contributed to an unknown hook: ${hookName}`);
      }) as StudioPluginContext['hooks']['contribute'],
    },
    storage: {
      dialect: storage.dialect,
      open: (migrations) => storage.open('studio_auth', migrations),
    },
    clients,
    models: { resolve: () => { throw new Error('not used'); } } as unknown as StudioPluginContext['models'],
  };

  const plugin = createStudioAuthPlugin({ secret: SECRET, ...options });
  await plugin.start(context);
  /** The Plugin's own tables, read through a handle that applies no migrations. */
  const inspect = async () => storage.open<StudioAuthDatabase>('test_inspector', {});

  async function call(
    route: string,
    input: { body?: unknown; token?: string } = {},
  ): Promise<{ status: number; body: unknown }> {
    const registered = routes.get(route);
    assert.ok(registered, `route ${route} is not registered`);
    const headers: Record<string, string> = {};
    if (input.token) headers.authorization = `Bearer ${input.token}`;
    const request = {
      url: new URL(`http://127.0.0.1:3211${registered.path}`),
      headers,
      readText: async () => (input.body === undefined ? '' : JSON.stringify(input.body)),
      readJson: async () => input.body ?? null,
      principal: { clientId: 'local', scope: 'studio' as const },
    } as unknown as StudioHttpRouteRequest;
    const result = await registered.handle(request);
    assert.equal(result.kind, 'json');
    return { status: result.status ?? 200, body: result.body };
  }

  const createUser = (username: string, extra: Record<string, unknown> = {}) => call('POST /users', {
    body: { username, password: PASSWORD, ...extra },
  });
  const login = (username: string, password = PASSWORD) => call('POST /auth/login', {
    body: { username, password },
  });

  return {
    plugin,
    routes,
    authenticators,
    contributions,
    clients,
    inspect,
    call,
    createUser,
    login,
    stop: async () => { await plugin.stop(); await storage.close(); },
  };
}

test('a user created by the Studio signs in with their own credentials as user.<name>', async (t) => {
  const h = await harness();
  t.after(h.stop);

  const created = await h.createUser('Ada');
  assert.equal(created.status, 201);
  assert.equal((created.body as { clientId: string }).clientId, 'user.ada');
  assert.deepEqual((created.body as { capabilities: string[] }).capabilities, [
    'channel.read', 'channel.write', 'studio.view',
  ]);

  const signedIn = await h.login('ada');
  assert.equal(signedIn.status, 200);
  const body = signedIn.body as { token: string; user: { clientId: string; username: string } };
  assert.ok(body.token.length >= 20);
  assert.equal(body.user.clientId, 'user.ada');
  assert.equal(body.user.username, 'ada');

  // The Studio client the Channel side recognises is created on demand.
  assert.equal((await h.clients.get('user.ada'))?.clientId, 'user.ada');

  const me = await h.call('GET /auth/me', { token: body.token });
  assert.equal(me.status, 200);
  assert.equal((me.body as { clientId: string }).clientId, 'user.ada');

  assert.equal((await h.call('GET /auth/me')).status, 401);

  // The session token is a credential the HTTP Plugin can verify by itself.
  const [authenticator] = [...h.authenticators];
  assert.ok(authenticator);
  const principal = await authenticator.verify(body.token);
  assert.deepEqual(principal, {
    clientId: 'user.ada',
    scope: 'client',
    capabilities: ['channel.read', 'channel.write', 'studio.view'],
  });
  assert.equal(await authenticator.verify('not-a-session-token'), undefined);

  assert.equal((await h.call('POST /auth/logout', { token: body.token })).status, 204);
  assert.equal((await h.call('GET /auth/me', { token: body.token })).status, 401);
  assert.equal(await authenticator.verify(body.token), undefined);
});

test('a wrong password is rejected and repeated failures lock the account', async (t) => {
  const h = await harness({ maxFailedAttempts: 2, lockoutMinutes: 15 });
  t.after(h.stop);
  await h.createUser('grace');

  const first = await h.login('grace', 'wrong-password-entirely');
  assert.equal(first.status, 401);
  assert.deepEqual(first.body, { error: 'Invalid username or password.' });

  assert.equal((await h.login('grace', 'wrong-password-entirely')).status, 401);

  const locked = await h.login('grace');
  assert.equal(locked.status, 429);
  const retryAfterSeconds = (locked.body as { retryAfterSeconds: number }).retryAfterSeconds;
  assert.ok(retryAfterSeconds > 0 && retryAfterSeconds <= 15 * 60);

  // An unknown username never reveals that it is unknown.
  assert.equal((await h.login('nobody-at-all', 'wrong-password-entirely')).status, 401);

  // Once the lock has elapsed the real password works again.
  const db = await h.inspect();
  await db.updateTable('studio_auth_user')
    .set({ locked_until: new Date(Date.now() - 1_000).toISOString() })
    .where('username', '=', 'grace')
    .execute();
  assert.equal((await h.login('grace')).status, 200);
});

test('a disabled user cannot sign in and loses the sessions they already hold', async (t) => {
  const h = await harness();
  t.after(h.stop);
  const { body } = await h.createUser('linus');
  const { userId } = body as { userId: string };
  const token = (await h.login('linus')).body as { token: string };

  assert.equal((await h.call('GET /auth/me', { token: token.token })).status, 200);
  assert.equal((await h.call('POST /users/disable', { body: { userId, disabled: true } })).status, 200);

  assert.equal((await h.call('GET /auth/me', { token: token.token })).status, 401);
  const denied = await h.login('linus');
  assert.equal(denied.status, 403);

  assert.equal((await h.call('POST /users/disable', { body: { userId, disabled: false } })).status, 200);
  assert.equal((await h.login('linus')).status, 200);
});

test('capabilities are an explicit grant: defaults are minimal and unknown names are refused', async (t) => {
  const h = await harness();
  t.after(h.stop);
  const { body } = await h.createUser('margaret');
  const { userId } = body as { userId: string };

  const granted = await h.call('POST /users/capabilities', {
    body: { userId, capabilities: ['studio.dispatch', 'pet.session', 'channel.read'] },
  });
  assert.equal(granted.status, 200);
  assert.deepEqual((granted.body as { capabilities: string[] }).capabilities, [
    'channel.read', 'studio.dispatch', 'pet.session',
  ]);

  const { token } = (await h.login('margaret')).body as { token: string };
  const me = await h.call('GET /auth/me', { token });
  assert.deepEqual((me.body as { capabilities: string[] }).capabilities, [
    'channel.read', 'studio.dispatch', 'pet.session',
  ]);

  const rejected = await h.call('POST /users/capabilities', {
    body: { userId, capabilities: ['channel.read', 'studio.everything'] },
  });
  assert.equal(rejected.status, 400);

  // A capability the user does not hold cannot be used, whatever the scope is.
  const [authenticator] = [...h.authenticators];
  assert.deepEqual((await authenticator!.verify(token))?.capabilities, [
    'channel.read', 'studio.dispatch', 'pet.session',
  ]);
});

test('changing a password requires the current one and revokes the other sessions', async (t) => {
  const h = await harness();
  t.after(h.stop);
  await h.createUser('barbara');

  const one = (await h.login('barbara')).body as { token: string };
  const two = (await h.login('barbara')).body as { token: string };
  assert.notEqual(one.token, two.token);

  const wrong = await h.call('POST /auth/password', {
    token: one.token,
    body: { currentPassword: 'not-the-current-password', newPassword: 'an-even-longer-password' },
  });
  assert.equal(wrong.status, 401);

  const changed = await h.call('POST /auth/password', {
    token: one.token,
    body: { currentPassword: PASSWORD, newPassword: 'an-even-longer-password' },
  });
  assert.equal(changed.status, 204);

  assert.equal((await h.call('GET /auth/me', { token: one.token })).status, 200);
  assert.equal((await h.call('GET /auth/me', { token: two.token })).status, 401);
  assert.equal((await h.login('barbara')).status, 401);
  assert.equal((await h.login('barbara', 'an-even-longer-password')).status, 200);
});

test('a revoked Studio client can no longer sign in', async (t) => {
  const h = await harness();
  t.after(h.stop);
  await h.createUser('ken');
  const { token } = (await h.login('ken')).body as { token: string };
  await h.clients.revoke('user.ken');

  assert.equal((await h.call('GET /auth/me', { token })).status, 401);
  assert.equal((await h.login('ken')).status, 403);
});

test('every login outcome is audited without the password or the session token', async (t) => {
  const h = await harness({ maxFailedAttempts: 1 });
  t.after(h.stop);
  await h.createUser('edsger', { capabilities: ['channel.read'] });

  const { token } = (await h.login('edsger')).body as { token: string };
  await h.login('edsger', 'wrong-password-entirely');
  await h.call('POST /auth/logout', { token });

  const db = await h.inspect();
  const rows = await db.selectFrom('studio_auth_audit').selectAll().execute();
  const actions = rows.map((row) => `${row.action}:${row.result}`).sort();
  assert.deepEqual(actions, ['login:denied', 'login:ok', 'logout:ok', 'user.create:ok']);

  const serialized = JSON.stringify(rows);
  assert.ok(!serialized.includes(PASSWORD));
  assert.ok(!serialized.includes(token));
  assert.ok(rows.every((row) => row.remote_addr === null || typeof row.remote_addr === 'string'));
});

test('without an HTTP route the Plugin still owns the tables but registers nothing', async (t) => {
  const h = await harness({ httpRoute: false });
  t.after(h.stop);
  assert.equal(h.routes.size, 0);
  assert.equal(h.authenticators.size, 0);
  assert.deepEqual(h.contributions, []);

  // The tables exist, so switching the HTTP routes on later finds its schema.
  const db = await h.inspect();
  const users = await db.selectFrom('studio_auth_user').selectAll().execute();
  assert.deepEqual(users, []);
});
