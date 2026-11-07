import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
async function harness(options: CreateStudioAuthPluginOptions = {}, autoStart = true) {
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
  if (autoStart) await plugin.start(context);
  /** The Plugin's own tables, read through a handle that applies no migrations. */
  const inspect = async () => storage.open<StudioAuthDatabase>('test_inspector', {});

  async function call(
    route: string,
    input: {
      body?: unknown;
      readJson?: () => Promise<unknown>;
      token?: string;
      headers?: Record<string, string>;
      remoteAddress?: string;
    } = {},
  ): Promise<{ status: number; body: unknown }> {
    const registered = routes.get(route);
    assert.ok(registered, `route ${route} is not registered`);
    const headers: Record<string, string> = { ...input.headers };
    if (input.token) headers.authorization = `Bearer ${input.token}`;
    const request = {
      url: new URL(`http://127.0.0.1:3211${registered.path}`),
      headers,
      ...(input.remoteAddress ? { remoteAddress: input.remoteAddress } : {}),
      readText: async () => (input.body === undefined ? '' : JSON.stringify(input.body)),
      readJson: input.readJson ?? (async () => input.body ?? null),
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
    context,
    storage,
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
  // Same answer as a wrong password: a disabled account is not a probe for
  // which usernames exist.
  assert.equal(denied.status, 401);
  assert.deepEqual(denied.body, { error: 'Invalid username or password.' });

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

test('the database keeps only the SHA-256 of a session token', async (t) => {
  const h = await harness();
  t.after(h.stop);
  await h.createUser('shafi');
  const { token } = (await h.login('shafi')).body as { token: string };

  const db = await h.inspect();
  const rows = await db.selectFrom('studio_auth_session').selectAll().execute();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.token, createHash('sha256').update(token).digest('hex'));
  assert.ok(!JSON.stringify(rows).includes(token));

  // A stolen row is not a credential either: presenting the hash does nothing.
  assert.equal((await h.call('GET /auth/me', { token: rows[0]!.token })).status, 401);
});

test('a session dies at its absolute lifetime and after an idle period', async (t) => {
  const h = await harness({ sessionTtlHours: 1, idleTimeoutMinutes: 30 });
  t.after(h.stop);
  await h.createUser('ada2');
  const db = await h.inspect();

  const expired = (await h.login('ada2')).body as { token: string };
  await db.updateTable('studio_auth_session')
    .set({ expires_at: new Date(Date.now() - 1_000).toISOString() })
    .execute();
  assert.equal((await h.call('GET /auth/me', { token: expired.token })).status, 401);
  // The dead session is removed, not just refused.
  assert.deepEqual(await db.selectFrom('studio_auth_session').selectAll().execute(), []);

  const idle = (await h.login('ada2')).body as { token: string };
  await db.updateTable('studio_auth_session')
    .set({ updated_at: new Date(Date.now() - 31 * 60_000).toISOString() })
    .execute();
  assert.equal((await h.call('GET /auth/me', { token: idle.token })).status, 401);
  assert.deepEqual(await db.selectFrom('studio_auth_session').selectAll().execute(), []);
});

test('parallel wrong passwords cannot slip under the lockout', async (t) => {
  const h = await harness({ maxFailedAttempts: 2 });
  t.after(h.stop);
  await h.createUser('hopper');

  const attempts = await Promise.all(Array.from({ length: 5 }, () => h.login('hopper', 'wrong-password-entirely')));
  assert.ok(attempts.every((attempt) => attempt.status === 401 || attempt.status === 429));
  // The counter never loses an increment, so the real password is refused too.
  assert.equal((await h.login('hopper')).status, 429);
});

test('a failing audit write does not fail the request', async (t) => {
  const h = await harness();
  t.after(h.stop);
  await h.createUser('lamarr');
  const db = await h.inspect();
  await db.schema.dropTable('studio_auth_audit').execute();

  assert.equal((await h.login('lamarr')).status, 200);
});

test('a failed start releases everything and can be retried', async (t) => {
  const h = await harness({}, false);
  t.after(h.stop);

  const unavailable: StudioPluginContext = {
    ...h.context,
    storage: {
      dialect: 'sqlite',
      open: async () => { throw new Error('storage is unavailable'); },
    },
  };
  await assert.rejects(async () => { await h.plugin.start(unavailable); }, /storage is unavailable/);
  // The retry gets a clean slate: routes register and accounts can be created.
  await h.plugin.start(h.context);
  assert.equal((await h.createUser('turing')).status, 201);
  assert.ok(h.routes.has('POST /auth/login'));
});

test('the audit trail records the socket address but ignores forwarded ones by default', async (t) => {
  const h = await harness();
  t.after(h.stop);
  await h.createUser('perlis');
  await h.call('POST /auth/login', {
    body: { username: 'perlis', password: PASSWORD },
    headers: { 'user-agent': 'studio-test/1.0', 'x-forwarded-for': '10.0.0.9' },
    remoteAddress: '::ffff:192.0.2.10',
  });

  const db = await h.inspect();
  const rows = await db.selectFrom('studio_auth_audit').selectAll().execute();
  const login = rows.find((row) => row.action === 'login' && row.result === 'ok');
  assert.equal(login?.user_agent, 'studio-test/1.0');
  // Nothing in front of this Plugin is trusted, so the header is not evidence:
  // the address the connection actually came from is.
  assert.equal(login?.remote_addr, '192.0.2.10');
});

test('a trusted proxy makes the forwarded address auditable', async (t) => {
  const h = await harness({ trustProxy: true });
  t.after(h.stop);
  await h.createUser('cocke');
  await h.call('POST /auth/login', {
    body: { username: 'cocke', password: PASSWORD },
    headers: { 'x-forwarded-for': '10.0.0.9, 10.0.0.1' },
    remoteAddress: '192.0.2.10',
  });

  const db = await h.inspect();
  const rows = await db.selectFrom('studio_auth_audit').selectAll().execute();
  const login = rows.find((row) => row.action === 'login' && row.result === 'ok');
  assert.equal(login?.remote_addr, '10.0.0.9');
});

test('a password change during a login cannot mint a session from the old password', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reachedBarrier!: () => void;
  const atBarrier = new Promise<void>((resolve) => { reachedBarrier = resolve; });

  const h = await harness({
    internalBeforeSessionCreate: async () => {
      reachedBarrier();
      await gate;
    },
  });
  t.after(h.stop);
  const { userId } = (await h.createUser('lovelace')).body as { userId: string };

  // The login verifies the old password and then waits just before minting.
  const pending = h.login('lovelace');
  await atBarrier;
  // The administrator replaces the credential while that verification result is
  // still in flight, and revokes every session.
  const reset = await h.call('POST /users/password', {
    body: { userId, password: 'another-long-password' },
  });
  assert.equal(reset.status, 204);
  release();

  const raced = await pending;
  assert.equal(raced.status, 401);

  const db = await h.inspect();
  assert.deepEqual(await db.selectFrom('studio_auth_session').selectAll().execute(), []);

  // The new credential is the only one that works.
  assert.equal((await h.login('lovelace')).status, 401);
  assert.equal((await h.login('lovelace', 'another-long-password')).status, 200);
});

test('an administrative password reset revokes the sessions already issued', async (t) => {
  const h = await harness();
  t.after(h.stop);
  const { userId } = (await h.createUser('torvalds')).body as { userId: string };
  const { token } = (await h.login('torvalds')).body as { token: string };
  assert.equal((await h.call('GET /auth/me', { token })).status, 200);

  assert.equal((await h.call('POST /users/password', {
    body: { userId, password: 'a-different-long-password' },
  })).status, 204);

  assert.equal((await h.call('GET /auth/me', { token })).status, 401);
  const db = await h.inspect();
  assert.deepEqual(await db.selectFrom('studio_auth_session').selectAll().execute(), []);
});

test('the usernames this Plugin accepts are the ones Better Auth accepts', async (t) => {
  const h = await harness();
  t.after(h.stop);

  // Short and hyphenated names pass USERNAME_PATTERN, so Better Auth must agree:
  // a name that passes here and is refused there would surface as a 409.
  for (const username of ['ab', 'ada-lovelace']) {
    const created = await h.createUser(username);
    assert.equal(created.status, 201, `${username} should be accepted`);
    assert.equal((created.body as { clientId: string }).clientId, `user.${username}`);
  }

  // Names the shared rule rejects are refused before any Studio client exists.
  for (const username of ['bad name', '-abc']) {
    const rejected = await h.createUser(username);
    assert.equal(rejected.status, 400, `${username} should be refused`);
  }
  const listed = await h.call('GET /users');
  assert.deepEqual(
    (listed.body as { users: { username: string }[] }).users.map((user) => user.username),
    ['ab', 'ada-lovelace'],
  );
  assert.equal(await h.clients.get('user.bad name'), undefined);
  assert.equal(await h.clients.get('user.-abc'), undefined);
});

test('a self-service password change cannot overwrite an administrative reset', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reachedBarrier!: () => void;
  const atBarrier = new Promise<void>((resolve) => { reachedBarrier = resolve; });

  const h = await harness({
    internalBeforeCredentialReplace: async () => {
      reachedBarrier();
      await gate;
    },
  });
  t.after(h.stop);
  const { userId } = (await h.createUser('hopper')).body as { userId: string };
  const { token } = (await h.login('hopper')).body as { token: string };

  // The change verifies the current password, hashes the replacement and then
  // waits: everything up to the write is already done and irreversible-looking.
  const pending = h.call('POST /auth/password', {
    token,
    body: { currentPassword: PASSWORD, newPassword: 'self-chosen-long-password' },
  });
  await atBarrier;
  // The administrator resets the password and revokes every session while that
  // verified change is still in flight.
  const reset = await h.call('POST /users/password', {
    body: { userId, password: 'admin-chosen-long-password' },
  });
  assert.equal(reset.status, 204);
  release();

  const raced = await pending;
  // The operator wins: the stale change is refused instead of clobbering it.
  assert.equal(raced.status, 409);
  assert.deepEqual(raced.body, { error: 'Password was changed elsewhere. Sign in again and retry.' });

  const db = await h.inspect();
  const audit = await db.selectFrom('studio_auth_audit').selectAll().execute();
  const denied = audit.find((row) =>
    row.action === 'password.change' && row.result === 'denied' && row.reason === 'credential-changed');
  assert.ok(denied, 'the refused change is recorded as credential-changed');
  // The refused change touched nothing: the reset had already revoked the
  // sessions and the rollback leaves no session of its own behind.
  assert.deepEqual(await db.selectFrom('studio_auth_session').selectAll().execute(), []);

  // The password an operator just set is the one that signs in.
  assert.equal((await h.login('hopper', 'self-chosen-long-password')).status, 401);
  assert.equal((await h.login('hopper', 'admin-chosen-long-password')).status, 200);
});

test('two racing self-service changes: the stale one is told to sign in again', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reachedBarrier!: () => void;
  const atBarrier = new Promise<void>((resolve) => { reachedBarrier = resolve; });
  let calls = 0;

  const h = await harness({
    internalBeforeCredentialReplace: async () => {
      calls += 1;
      // Only the first change is held; the second one lands while it waits.
      if (calls === 1) {
        reachedBarrier();
        await gate;
      }
    },
  });
  t.after(h.stop);
  await h.createUser('church');
  const { token } = (await h.login('church')).body as { token: string };

  const first = h.call('POST /auth/password', {
    token,
    body: { currentPassword: PASSWORD, newPassword: 'first-device-long-password' },
  });
  await atBarrier;
  const second = await h.call('POST /auth/password', {
    token,
    body: { currentPassword: PASSWORD, newPassword: 'second-device-long-password' },
  });
  assert.equal(second.status, 204);
  release();

  const raced = await first;
  assert.equal(raced.status, 409);
  assert.equal((await h.login('church', 'first-device-long-password')).status, 401);
  assert.equal((await h.login('church', 'second-device-long-password')).status, 200);
});

test('two racing administrative resets: the stale one is refused instead of overwriting', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reachedBarrier!: () => void;
  const atBarrier = new Promise<void>((resolve) => { reachedBarrier = resolve; });
  let resets = 0;

  const h = await harness({
    internalBeforeAdminReset: async () => {
      resets += 1;
      // Only the first operator is held; the second one lands while it waits.
      if (resets === 1) {
        reachedBarrier();
        await gate;
      }
    },
  });
  t.after(h.stop);
  const { userId } = (await h.createUser('ritchie')).body as { userId: string };

  const first = h.call('POST /users/password', {
    body: { userId, password: 'first-operator-long-password' },
  });
  await atBarrier;
  const second = await h.call('POST /users/password', {
    body: { userId, password: 'second-operator-long-password' },
  });
  assert.equal(second.status, 204);
  release();

  const raced = await first;
  // The reset that actually landed wins; the other one is told to reload
  // instead of quietly putting its own password back.
  assert.equal(raced.status, 409);
  assert.deepEqual(raced.body, { error: 'Password was changed elsewhere. Reload the user and retry.' });

  const db = await h.inspect();
  const audit = await db.selectFrom('studio_auth_audit').selectAll().execute();
  const denied = audit.find((row) =>
    row.action === 'user.password' && row.result === 'denied' && row.reason === 'credential-changed');
  assert.ok(denied, 'the refused reset is recorded as credential-changed');

  assert.equal((await h.login('ritchie', 'first-operator-long-password')).status, 401);
  assert.equal((await h.login('ritchie', 'second-operator-long-password')).status, 200);
});

test('disabling an account stops a self-service change that is already in flight', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reachedBarrier!: () => void;
  const atBarrier = new Promise<void>((resolve) => { reachedBarrier = resolve; });

  const h = await harness({
    internalBeforeCredentialReplace: async () => {
      reachedBarrier();
      await gate;
    },
  });
  t.after(h.stop);
  const { userId } = (await h.createUser('backus')).body as { userId: string };
  const { token } = (await h.login('backus')).body as { token: string };

  const pending = h.call('POST /auth/password', {
    token,
    body: { currentPassword: PASSWORD, newPassword: 'self-chosen-long-password' },
  });
  await atBarrier;
  // The account is disabled while that verified change is still in flight.
  assert.equal((await h.call('POST /users/disable', { body: { userId, disabled: true } })).status, 200);
  release();

  const raced = await pending;
  // Disabling bumps the credential version, so the stale change cannot land.
  assert.equal(raced.status, 409);

  // Enabling again proves the refused change left the password alone.
  assert.equal((await h.call('POST /users/disable', { body: { userId, disabled: false } })).status, 200);
  assert.equal((await h.login('backus', 'self-chosen-long-password')).status, 401);
  assert.equal((await h.login('backus')).status, 200);
});


test('disabling during body read cannot authorize a password change with the newer version', async (t) => {
  const h = await harness();
  t.after(h.stop);
  const { userId } = (await h.createUser('body-race')).body as { userId: string };
  const { token } = (await h.login('body-race')).body as { token: string };
  const result = await h.call('POST /auth/password', {
    token,
    readJson: async () => {
      assert.equal((await h.call('POST /users/disable', { body: { userId, disabled: true } })).status, 200);
      return { currentPassword: PASSWORD, newPassword: 'unauthorized-new-password' };
    },
  });
  assert.equal(result.status, 409);
  assert.equal((await h.call('POST /users/disable', { body: { userId, disabled: false } })).status, 200);
  assert.equal((await h.login('body-race', 'unauthorized-new-password')).status, 401);
  assert.equal((await h.login('body-race')).status, 200);
});

for (const loss of ['logout', 'absolute-expiry', 'idle-expiry', 'client-revocation'] as const) {
  test(`a password change rolls back if its session loses authorization before commit: ${loss}`, async (t) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const barrier = new Promise<void>((resolve) => { reached = resolve; });
    const h = await harness({ internalBeforeCredentialReplace: async () => { reached(); await gate; } });
    t.after(h.stop);
    t.after(() => release());
    await h.createUser('commit-race');
    const { token } = (await h.login('commit-race')).body as { token: string };
    const db = await h.inspect();
    const userBefore = await db.selectFrom('studio_auth_user').selectAll().executeTakeFirstOrThrow();
    const accountBefore = await db.selectFrom('studio_auth_account').selectAll().executeTakeFirstOrThrow();
    const pending = h.call('POST /auth/password', {
      token, body: { currentPassword: PASSWORD, newPassword: 'unauthorized-new-password' },
    });
    await barrier;
    if (loss === 'logout') {
      assert.equal((await h.call('POST /auth/logout', { token })).status, 204);
    } else if (loss === 'client-revocation') {
      await h.clients.revoke('user.commit-race');
    } else {
      await db.updateTable('studio_auth_session').set(loss === 'absolute-expiry'
        ? { expires_at: new Date(Date.now() - 1_000).toISOString() }
        : { updated_at: new Date(Date.now() - 31 * 60_000).toISOString() }).execute();
    }
    release();
    assert.equal((await pending).status, 401);
    const userAfter = await db.selectFrom('studio_auth_user').selectAll().executeTakeFirstOrThrow();
    const accountAfter = await db.selectFrom('studio_auth_account').selectAll().executeTakeFirstOrThrow();
    assert.equal(accountAfter.password, accountBefore.password, 'refused change must leave the password unchanged');
    assert.equal(userAfter.credential_version, userBefore.credential_version, 'refused change must roll back the version bump');
    const successes = await db.selectFrom('studio_auth_audit').selectAll()
      .where('action', '=', 'password.change').where('result', '=', 'ok').execute();
    assert.deepEqual(successes, [], 'refused change must not be audited as success');
  });
}
