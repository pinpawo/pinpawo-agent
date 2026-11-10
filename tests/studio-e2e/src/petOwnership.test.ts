import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStudio, prepareStudio, createStudioStorage, type StudioPetRuntime, type StudioStorageConfig } from '@pinpawo/studio-core';
import { createChannelPlugin } from '@pinpawo-plugin/channel';
import { createStudioHttpPlugin } from '@pinpawo-plugin/studio-http';
import { studioCoreMigrations } from '../../../packages/studio/src/storage/coreMigrations';
import { createPglitePool } from '../../support/pglitePool';
import type { PetDatabase } from '../../../packages/studio/src/pets/store/kysely';

const human = { kind: 'human' as const, id: 'local' };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function runtime(close = async () => {}): StudioPetRuntime {
  return { close, dispatch: {
    getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
    onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {}, dispatch: async () => {},
  } };
}

for (const [backend, storage] of [
  ['sqlite', () => ({ kind: 'sqlite', path: ':memory:' })],
  ['postgres', () => ({ kind: 'postgres', pool: createPglitePool() })],
] as Array<[string, () => StudioStorageConfig]>) {
test(`${backend}: one definition produces isolated Channel-owned instances; membership cannot reparent or revive them`, async t => {
  const channel = createChannelPlugin({ httpRoute: false });
  const assembled: string[] = [];
  const studio = await createStudio({ studioId: 'ownership', storage: storage(), plugins: [channel], credentialsKey: new Uint8Array(32).fill(7),
    definitions: [{ definitionId: 'shared', name: 'Shared' }],
    assemblePet: async pet => { assembled.push(pet.petId); return runtime(); },
  });
  t.after(() => studio.shutdown());
  const a = (await channel.service.createChannel(human, { title: 'A' })).channel.channelId;
  const b = (await channel.service.createChannel(human, { title: 'B' })).channel.channelId;
  await assert.rejects(studio.pets.create({ petId: 'missing', definitionId: 'shared', name: 'Missing', channelId: 'absent' }), /owner Channel/);
  assert.equal(await studio.pets.get('missing'), undefined);
  for (const [petId, channelId] of [['one', a], ['two', b]]) {
    await studio.pets.create({ petId, channelId, definitionId: 'shared', name: 'Same name' });
  }
  assert.deepEqual(assembled, ['one', 'two']);
  assert.deepEqual((await channel.service.members(a)).map(member => member.id), ['local', 'one']);
  assert.ok((await channel.service.store.listMembers(a)).every(member => member.kind === 'human'), 'no second Pet ownership truth');
  await assert.rejects(channel.service.addMember(human, b, { kind: 'pet', id: 'one' }), /separate instance/);
  await studio.pets.credentials.set({ petId: 'one', envName: 'TOKEN', value: 'instance-one-only' });
  assert.deepEqual(await studio.pets.credentials.list('two'), []);
  await channel.service.reserveSession(a, 'one', () => 'one:session');
  await channel.service.removeMember(human, a, { kind: 'pet', id: 'one' }, { confirmStop: true });
  assert.ok((await studio.pets.get('one'))?.removedAt);
  assert.equal((await studio.pets.get('one'))?.channelId, a);
  assert.equal((await studio.pets.credentials.list('one')).length, 1);
  assert.equal((await channel.service.getSession(a, 'one'))?.sessionId, 'one:session');
  await assert.rejects(studio.dispatch({ petId: 'one', request: 'closed' }));
  await assert.rejects(channel.service.addMember(human, a, { kind: 'pet', id: 'one' }));
  await assert.rejects(studio.pets.create({ petId: 'one', channelId: b, definitionId: 'shared', name: 'New' }), /already exists/);
  assert.deepEqual(studio.listPets().map(pet => pet.petId), ['two']);
});

}

test('removing one active instance refuses new admission without blocking other Channels or registry changes', async t => {
  const finishing = deferred();
  const began = deferred();
  let closeCalls = 0;
  const channel = createChannelPlugin({ httpRoute: false });
  const studio = await createStudio({ studioId: 'close-concurrency', plugins: [channel], definitions: [{ definitionId: 'shared', name: 'Shared' }],
    assemblePet: async pet => runtime(pet.petId === 'one' ? async () => { closeCalls++; began.resolve(); await finishing.promise; } : undefined),
  });
  t.after(async () => { finishing.resolve(); await studio.shutdown(); });
  const a = (await channel.service.createChannel(human, { title: 'A' })).channel.channelId;
  const b = (await channel.service.createChannel(human, { title: 'B' })).channel.channelId;
  await studio.pets.create({ petId: 'one', definitionId: 'shared', name: 'One', channelId: a });
  const closing = studio.pets.removeInstance('one', { confirmStop: true });
  await began.promise;
  assert.ok(!(await channel.service.members(a)).some(member => member.id === 'one'));
  await assert.rejects(channel.service.readContext({ kind: 'pet', id: 'one' }, a));
  const again = studio.pets.removeInstance('one', { confirmStop: true });
  await assert.rejects(studio.dispatch({ petId: 'one', request: 'too late' }));
  await studio.pets.create({ petId: 'two', definitionId: 'shared', name: 'Two', channelId: b });
  await studio.pets.rename('two', 'Renamed');
  assert.equal(closeCalls, 1);
  finishing.resolve();
  assert.deepEqual(await closing, await again);
});

test('a final resident reply delayed past removal persists without fresh handoff work', async t => {
  const channel = createChannelPlugin({ httpRoute: false });
  const delayed = deferred();
  const handling = deferred();
  let emit: Parameters<StudioPetRuntime['dispatch']['onDispatchLifecycle']>[0] | undefined;
  let sessionId = '';
  let channelId = '';
  let fresh = 0;
  const studio = await createStudio({ studioId: 'final-reply', plugins: [channel], definitions: [{ definitionId: 'shared', name: 'Shared' }],
    assemblePet: async pet => {
      const value = runtime(pet.petId === 'one' ? async () => {
        emit?.({ state: 'running', dispatchId: 'accepted-work', request: 'original', sessionId, scope: { namespace: 'channel', id: channelId } } as Parameters<NonNullable<typeof emit>>[0]);
        emit?.({ state: 'message', dispatchId: 'accepted-work', request: 'original', sessionId,
          scope: { namespace: 'channel', id: channelId },
          message: { type: 'message.completed', messageId: 'last-message', text: '[@Two](participant:pet:two) Final output.' },
        } as Parameters<NonNullable<typeof emit>>[0]);
      } : undefined);
      if (pet.petId === 'one') value.dispatch.onDispatchLifecycle = listener => { emit = listener; return () => { emit = undefined; }; };
      else value.dispatch.dispatch = async () => { fresh++; };
      return value;
    },
  });
  t.after(async () => { delayed.resolve(); await studio.shutdown(); });
  channelId = (await channel.service.createChannel(human, { title: 'A' })).channel.channelId;
  for (const petId of ['one', 'two']) await studio.pets.create({ petId, definitionId: 'shared', name: petId, channelId });
  sessionId = (await channel.service.reserveSession(channelId, 'one', () => 'one:accepted')).sessionId;
  const original = channel.service.getSession.bind(channel.service);
  channel.service.getSession = async (...args) => { handling.resolve(); await delayed.promise; return original(...args); };
  await studio.pets.removeInstance('one', { confirmStop: true });
  await handling.promise;
  delayed.resolve();
  for (let i = 0; i < 100; i++) {
    if ((await channel.service.readContext(human, channelId)).messages.length) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal((await channel.service.readContext(human, channelId)).messages[0]?.body, '[@Two](participant:pet:two) Final output.');
  assert.equal(fresh, 0);
});

test('failed assembly retains a closed bound identity and restore rollback closes every partial runtime', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pet-owner-restore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = { kind: 'sqlite' as const, path: path.join(root, 'studio.sqlite') };
  let channel = createChannelPlugin({ httpRoute: false });
  const first = await createStudio({ studioId: 'restore', storage, plugins: [channel], definitions: [{ definitionId: 'shared', name: 'Shared' }],
    assemblePet: async pet => { if (pet.petId === 'failed') throw new Error('assembly failed'); return runtime(); },
  });
  const channelId = (await channel.service.createChannel(human, { title: 'A' })).channel.channelId;
  for (const petId of ['one', 'two']) await first.pets.create({ petId, definitionId: 'shared', name: petId, channelId });
  await assert.rejects(first.pets.create({ petId: 'failed', definitionId: 'shared', name: 'Failed', channelId }), /assembly failed/);
  assert.ok((await first.pets.get('failed'))?.closedAt);
  await first.shutdown();
  const closed: string[] = [];
  channel = createChannelPlugin({ httpRoute: false });
  const prepared = prepareStudio({ studioId: 'restore', storage, plugins: [channel], definitions: [{ definitionId: 'shared', name: 'Shared' }],
    assemblePet: async pet => { if (pet.petId === 'two') throw new Error('restore failed'); return runtime(async () => { closed.push(pet.petId); }); },
  });
  t.after(() => prepared.studio.shutdown());
  // create before explicit restore exercises the same rollback path.
  await assert.rejects(prepared.studio.pets.create({ petId: 'new', definitionId: 'shared', name: 'New', channelId }), /restore failed/);
  assert.deepEqual(closed, ['one']);
  assert.deepEqual(prepared.studio.listPets(), []);
  assert.equal((await prepared.studio.pets.list()).length, 3);
});

test('ownerless persisted rows fail explicitly without dropping user data or assembling a runtime', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pet-owner-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { kind: 'sqlite' as const, path: path.join(root, 'studio.sqlite') };
  const storage = createStudioStorage(config);
  const db = await storage.open<PetDatabase>('studio', Object.fromEntries(Object.entries(studioCoreMigrations).filter(([id]) => id < '0004_pet_channel')));
  await db.insertInto('studio_pets').values({ pet_id: 'old', definition_id: 'shared', name: 'Keep', created_at: 'then' } as never).execute();
  await db.insertInto('studio_pet_credentials').values({ pet_id: 'old', env_name: 'TOKEN', encrypted_value: 'preserved-envelope', updated_at: 'then' }).execute();
  await storage.close();
  let assembled = false;
  const prepared = prepareStudio({ studioId: 'old', storage: config, definitions: [{ definitionId: 'shared', name: 'Shared' }],
    assemblePet: async () => { assembled = true; return runtime(); },
  });
  await assert.rejects(prepared.restorePets(), /Pet "old" has no owner Channel/);
  assert.equal(assembled, false);
  await prepared.studio.shutdown();
  const previous = createStudioStorage(config);
  const unchanged = await previous.open<PetDatabase>('studio', Object.fromEntries(Object.entries(studioCoreMigrations).filter(([id]) => id < '0004_pet_channel')));
  assert.equal((await unchanged.selectFrom('studio_pets').select('name').executeTakeFirst())?.name, 'Keep');
  assert.equal((await unchanged.selectFrom('studio_pet_credentials').select('encrypted_value').executeTakeFirst())?.encrypted_value, 'preserved-envelope');
  await previous.close();
});

test('HTTP keeps definition assembly at Studio authority while confirmed member removal permanently removes an owned instance', async t => {
  const channel = createChannelPlugin();
  const http = createStudioHttpPlugin({ port: 0, authToken: 'owner-test-token' });
  const studio = await createStudio({ studioId: 'authority', plugins: [channel, http], definitions: [{ definitionId: 'shared', name: 'Shared' }], assemblePet: async () => runtime() });
  t.after(() => studio.shutdown());
  const url = `http://127.0.0.1:${http.address()!.port}`;
  const call = async (token: string, route: string, body?: unknown) => fetch(url + route, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  await call('owner-test-token', '/clients', { clientId: 'member', label: 'Member' });
  const key = await (await call('owner-test-token', '/clients/keys', { clientId: 'member' })).json() as { key: string };
  const created = await (await call(key.key, '/channels', { title: 'Members', pets: [] })).json() as { channel: { channelId: string } };
  const input = { petId: 'one', definitionId: 'shared', name: 'One', channelId: created.channel.channelId };
  assert.equal((await call(key.key, '/pets', input)).status, 403);
  assert.equal((await call(key.key, '/pet-definitions')).status, 403);
  assert.equal((await call('owner-test-token', '/pets', input)).status, 201);
  assert.equal((await call(key.key, '/channels', { title: 'Reparent', pets: ['one'] })).status, 400);
  assert.equal((await call(key.key, '/channels/members/remove', { channelId: input.channelId, kind: 'pet', id: 'one', confirmStop: true })).status, 200);
  assert.ok((await studio.pets.get('one'))?.removedAt);
  assert.equal((await call(key.key, '/pets/close', { petId: 'one' })).status, 403);
});

test('reusing a Channel Plugin object validates ownership against the current Studio database', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pet-owner-plugin-reuse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = { kind: 'sqlite' as const, path: path.join(root, 'studio.sqlite') };
  const channel = createChannelPlugin({ httpRoute: false });
  const input = { studioId: 'reuse', storage, plugins: [channel], definitions: [{ definitionId: 'shared', name: 'Shared' }], assemblePet: async () => runtime() };
  const first = await createStudio(input);
  const channelId = (await channel.service.createChannel(human, { title: 'Owner' })).channel.channelId;
  await first.pets.create({ petId: 'one', definitionId: 'shared', name: 'One', channelId });
  await first.shutdown();
  const second = await createStudio(input);
  t.after(() => second.shutdown());
  assert.equal(second.listPets()[0]?.channelId, channelId);
  await second.pets.create({ petId: 'two', definitionId: 'shared', name: 'Two', channelId });
  assert.equal((await channel.service.members(channelId)).length, 3);
});

test('runtime stop failure retains identity without falsely marking it removed or admitting new work', async t => {
  const channel = createChannelPlugin({ httpRoute: false });
  const studio = await createStudio({ studioId: 'close-failure', plugins: [channel], definitions: [{ definitionId: 'shared', name: 'Shared' }],
    assemblePet: async () => runtime(async () => { throw new Error('close failed'); }),
  });
  t.after(() => studio.shutdown());
  const channelId = (await channel.service.createChannel(human, { title: 'Owner' })).channel.channelId;
  await studio.pets.create({ petId: 'one', definitionId: 'shared', name: 'One', channelId });
  await assert.rejects(channel.service.removeMember(human, channelId, { kind: 'pet', id: 'one' }, { confirmStop: true }), /close failed/);
  assert.equal((await studio.pets.get('one'))?.removedAt, undefined);
  assert.equal((await studio.pets.get('one'))?.closedAt, undefined);
  assert.deepEqual(studio.listPets(), []);
  await assert.rejects(studio.dispatch({ petId: 'one', request: 'late' }));
  await assert.rejects(studio.pets.removeInstance('one', { confirmStop: true }), /close failed/);
});

test('a Studio without Channel ownership cannot assemble a standalone instance', async t => {
  let assembled = false;
  const studio = await createStudio({ studioId: 'no-channel', definitions: [{ definitionId: 'shared', name: 'Shared' }],
    assemblePet: async () => { assembled = true; return runtime(); },
  });
  t.after(() => studio.shutdown());
  await assert.rejects(studio.pets.create({ petId: 'one', definitionId: 'shared', name: 'One', channelId: 'missing' }), /Channel Plugin is required/);
  assert.equal(assembled, false);
  assert.deepEqual(await studio.pets.list(), []);
});

test('restore refuses a persisted instance whose owner Channel is missing before any assembly', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pet-owner-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = { kind: 'sqlite' as const, path: path.join(root, 'studio.sqlite') };
  const firstChannel = createChannelPlugin({ httpRoute: false });
  const first = await createStudio({ studioId: 'missing-owner', storage, plugins: [firstChannel], definitions: [{ definitionId: 'shared', name: 'Shared' }], assemblePet: async () => runtime() });
  const channelId = (await firstChannel.service.createChannel(human, { title: 'Owner' })).channel.channelId;
  await first.pets.create({ petId: 'one', definitionId: 'shared', name: 'One', channelId });
  await first.shutdown();
  const tampered = createStudioStorage(storage);
  const db = await tampered.open<PetDatabase>('studio', studioCoreMigrations);
  await db.updateTable('studio_pets').set({ channel_id: 'missing' }).where('pet_id', '=', 'one').execute();
  await tampered.close();
  let assembled = false;
  const prepared = prepareStudio({ studioId: 'missing-owner', storage, plugins: [createChannelPlugin({ httpRoute: false })], definitions: [{ definitionId: 'shared', name: 'Shared' }],
    assemblePet: async () => { assembled = true; return runtime(); },
  });
  t.after(() => prepared.studio.shutdown());
  await assert.rejects(prepared.restorePets(), /No owner Channel "missing"/);
  assert.equal(assembled, false);
  assert.deepEqual(prepared.studio.listPets(), []);
  assert.equal((await prepared.studio.pets.get('one'))?.channelId, 'missing');
});


test('a confirmed temporarily closed instance reopens with the same owner, session and credentials; removed instances never restore', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pet-reopen-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = { kind: 'sqlite' as const, path: path.join(root, 'studio.sqlite') };
  const key = new Uint8Array(32).fill(7);
  let assembled = 0;
  const open = async () => {
    const channel = createChannelPlugin({ httpRoute: false });
    const prepared = prepareStudio({ studioId: 'reopen', storage, plugins: [channel], credentialsKey: key,
      definitions: [{ definitionId: 'shared', name: 'Shared' }], assemblePet: async () => { assembled++; return runtime(); },
    });
    await prepared.activatePlugins();
    return { studio: prepared.studio, channel, credentialSource: prepared.credentialSource };
  };
  const first = await open();
  const channelId = (await first.channel.service.createChannel(human, { title: 'Owner' })).channel.channelId;
  const original = await first.studio.pets.create({ petId: 'same', definitionId: 'shared', name: 'Same', channelId });
  await first.studio.pets.credentials.set({ petId: 'same', envName: 'TOKEN', value: 'test-only-value' });
  await first.channel.service.reserveSession(channelId, 'same', () => 'same:00000001');
  const closed = await first.studio.pets.closeInstance('same', { confirmStop: true });
  assert.ok(closed.closedAt);
  assert.equal(closed.removedAt, undefined);
  assert.deepEqual(await first.credentialSource.environment('same'), { TOKEN: 'test-only-value' });
  await first.studio.shutdown();
  const second = await open();
  assert.equal(assembled, 1, 'closed records do not restore until explicitly reopened');
  assert.equal(second.studio.listPets().length, 0);
  const [reopened, repeated] = await Promise.all([second.studio.pets.reopenInstance('same'), second.studio.pets.reopenInstance('same')]);
  assert.deepEqual(reopened, original);
  assert.deepEqual(repeated, original);
  assert.equal(assembled, 2, 'duplicate Reopen requests assemble exactly once');
  assert.equal((await second.channel.service.getSession(channelId, 'same'))?.sessionId, 'same:00000001');
  assert.equal((await second.studio.pets.credentials.list('same')).length, 1);
  assert.deepEqual(await second.credentialSource.environment('same'), { TOKEN: 'test-only-value' });
  assert.equal((await second.studio.pets.get('same'))?.channelId, channelId);
  await second.studio.pets.removeInstance('same', { confirmStop: true });
  await second.studio.shutdown();
  const third = await open();
  t.after(() => third.studio.shutdown());
  assert.equal(assembled, 2, 'a permanent tombstone never assembles on restart');
  await assert.rejects(third.studio.pets.reopenInstance('same'), /permanently removed/);
  assert.equal((await third.channel.service.getSession(channelId, 'same'))?.sessionId, 'same:00000001');
  assert.equal((await third.studio.pets.credentials.list('same')).length, 1);
});
