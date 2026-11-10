import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  prepareStudio, createStudioStorage, type StudioPetRuntime, type StudioStorageConfig,
} from '@pinpawo/studio-core';
import { createPglitePool } from '../../../tests/support/pglitePool';
import { createChannelPlugin } from './channelPlugin';
import { channelMigrations, KyselyChannelStore, type ChannelDatabase } from './store/kysely';

const owner = { kind: 'human' as const, id: 'owner' };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
function runtime(): StudioPetRuntime {
  return { close: async () => {}, dispatch: {
    getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
    onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {}, dispatch: async () => {},
  } };
}
for (const [backend, config] of [
  ['sqlite', () => ({ kind: 'sqlite', path: ':memory:' })],
  ['postgres', () => ({ kind: 'postgres', pool: createPglitePool() })],
] as Array<[string, () => StudioStorageConfig]>) {
  test(`${backend}: instance enrollment precedes assembly and never uses raw Pet membership as authority`, async t => {
    const plugin = createChannelPlugin({ httpRoute: false });
    const entered = deferred(), release = deferred();
    t.after(() => release.resolve());
    const prepared = prepareStudio({ studioId: 'enrollment', storage: config(), plugins: [plugin],
      definitions: [{ definitionId: 'worker', name: 'Worker' }],
      assemblePet: async () => { entered.resolve(); await release.promise; return runtime(); },
    });
    t.after(() => prepared.studio.shutdown());
    await prepared.activatePlugins();
    const channel = (await plugin.service.createChannel(owner, { title: 'Owner' })).channel;
    const other = (await plugin.service.createChannel(owner, { title: 'Other' })).channel;
    const before = (await plugin.service.postMessage(owner, channel.channelId, { body: 'Before enrollment' })).message;
    // Legacy membership rows, even current in a different Channel, grant nothing.
    await plugin.service.store.upsertMember({ channelId: other.channelId, kind: 'pet', id: 'pet', joinedAt: 'legacy' });
    const creating = prepared.studio.pets.create({ petId: 'pet', name: 'Pet', definitionId: 'worker', channelId: channel.channelId });
    await entered.promise;
    const baseline = await plugin.service.store.getConsumption(channel.channelId, 'pet');
    assert.equal(baseline?.afterSequence, before.sequence, 'a baseline exists before assembly exposes any runtime');
    assert.equal(await plugin.service.store.getConsumption(other.channelId, 'pet'), undefined);
    assert.deepEqual(prepared.studio.listPets(), [], 'the persisted record is not yet a live instance');
    await assert.rejects(plugin.service.consumption(channel.channelId, 'pet'));
    const after = (await plugin.service.postMessage(owner, channel.channelId, { body: 'After enrollment, before live' })).message;
    release.resolve();
    await creating;
    const progress = await plugin.service.consumption(channel.channelId, 'pet');
    assert.equal(progress.afterSequence, before.sequence, 'late pet.created notification cannot move the cutoff');
    assert.deepEqual((await plugin.service.store.listMembers(channel.channelId)).map(row => row.kind), ['human']);
    assert.equal(await plugin.service.advanceConsumption(progress, after.sequence), true, 'owner authority does not require a raw Pet membership');
    await plugin.service.store.enrollConsumption({ channelId: other.channelId, petId: 'pet', activationId: 'orphan', afterSequence: 0 });
    await assert.rejects(plugin.service.consumption(other.channelId, 'pet'));
    assert.equal(await plugin.service.advanceConsumption({ channelId: other.channelId, petId: 'pet', activationId: 'orphan', afterSequence: 0 }, after.sequence), false,
      'even an orphan progress row and raw membership cannot grant another owner authority');
    await plugin.service.addMember(owner, channel.channelId, { kind: 'pet', id: 'pet' });
    assert.equal((await plugin.service.consumption(channel.channelId, 'pet')).afterSequence, after.sequence, 'adding an existing projection never resets progress');
  });

  test(`${backend}: enrollment locks the Channel before observing the tail and inserting only missing progress`, async t => {
    const storage = createStudioStorage(config());
    t.after(() => storage.close());
    const store = new KyselyChannelStore(await storage.open<ChannelDatabase>('channel', channelMigrations(storage.dialect)));
    const order: string[] = [];
    const wrapped = new Proxy(store, { get(target, key) {
      if (key === 'transaction') return (work: (value: typeof store) => Promise<unknown>) => target.transaction(trx => work(new Proxy(trx, { get(inner, method) {
        const value = Reflect.get(inner, method);
        if (['lockChannel', 'getConsumption', 'readMessages', 'enrollConsumption'].includes(String(method))) return (...args: unknown[]) => {
          order.push(String(method)); return value.apply(inner, args);
        };
        return typeof value === 'function' ? value.bind(inner) : value;
      } }) as typeof store));
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const plugin = createChannelPlugin({ store: wrapped, httpRoute: false });
    const prepared = prepareStudio({ studioId: 'ordered', storage: config(), plugins: [plugin],
      definitions: [{ definitionId: 'worker', name: 'Worker' }], assemblePet: async () => runtime(),
    });
    t.after(() => prepared.studio.shutdown());
    await prepared.activatePlugins();
    const channel = (await plugin.service.createChannel(owner, { title: 'Owner' })).channel;
    order.length = 0;
    await prepared.studio.pets.create({ petId: 'pet', name: 'Pet', definitionId: 'worker', channelId: channel.channelId });
    assert.deepEqual(order, ['lockChannel', 'getConsumption', 'readMessages', 'enrollConsumption']);
  });

  test(`${backend}: Channel migration does not grant enrollment to legacy raw Pet rows or rewrite history`, async t => {
    const storage = createStudioStorage(config());
    t.after(() => storage.close());
    const migrations = channelMigrations(storage.dialect);
    const old = await storage.open<ChannelDatabase>('channel', {
      '0001_channels': migrations['0001_channels']!, '0002_channel_prompt': migrations['0002_channel_prompt']!,
    });
    await old.insertInto('channels').values({ channel_id: 'one', title: 'One', description: null, prompt: null,
      created_by_kind: 'human', created_by_id: 'owner', created_at: 'then', updated_at: 'then' }).execute();
    await old.insertInto('channel_members').values({ channel_id: 'one', member_kind: 'pet', member_id: 'orphan', joined_at: 'then', left_at: null }).execute();
    const db = await storage.open<ChannelDatabase>('channel', migrations);
    assert.equal(await new KyselyChannelStore(db).getConsumption('one', 'orphan'), undefined);
    assert.equal((await db.selectFrom('channel_members').selectAll().execute()).length, 1, 'historical data remains intact');
  });
}

test('ordinary SQLite restart preserves cursors and repairs an authoritative instance missed by the old ownership-only bridge', async t => {
  const root = await mkdtemp(join(tmpdir(), 'instance-consumption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = { kind: 'sqlite' as const, path: join(root, 'studio.sqlite') };
  const open = async () => {
    const plugin = createChannelPlugin({ httpRoute: false });
    const prepared = prepareStudio({ studioId: 'persistent', storage, plugins: [plugin],
      definitions: [{ definitionId: 'worker', name: 'Worker' }], assemblePet: async () => runtime(),
    });
    await prepared.activatePlugins();
    return { plugin, studio: prepared.studio };
  };
  const first = await open();
  const channel = (await first.plugin.service.createChannel(owner, { title: 'Persistent' })).channel;
  await first.studio.pets.create({ petId: 'a', name: 'A', definitionId: 'worker', channelId: channel.channelId });
  await first.studio.pets.create({ petId: 'b', name: 'B', definitionId: 'worker', channelId: channel.channelId });
  const acknowledged = (await first.plugin.service.postMessage(owner, channel.channelId, { body: 'Acknowledged by A' })).message;
  await first.plugin.service.advanceConsumption(await first.plugin.service.consumption(channel.channelId, 'a'), acknowledged.sequence);
  // Reproduce the old ownership-only bridge: a persisted/live instance exists,
  // but creating it through the registry never enrolled Channel progress.
  const prepareInstance = first.plugin.petChannels!.prepareInstance;
  first.plugin.petChannels!.prepareInstance = undefined;
  await first.studio.pets.create({ petId: 'legacy', name: 'Legacy', definitionId: 'worker', channelId: channel.channelId });
  assert.equal(await first.plugin.service.store.getConsumption(channel.channelId, 'legacy'), undefined);
  first.plugin.petChannels!.prepareInstance = prepareInstance;
  const pending = (await first.plugin.service.postMessage(owner, channel.channelId, { body: 'Pending' })).message;
  const positions = [await first.plugin.service.consumption(channel.channelId, 'a'), await first.plugin.service.consumption(channel.channelId, 'b')];
  await first.studio.shutdown();
  const second = await open();
  t.after(() => second.studio.shutdown());
  assert.equal((await second.plugin.service.consumption(channel.channelId, 'a')).afterSequence, positions[0]!.afterSequence);
  assert.equal((await second.plugin.service.consumption(channel.channelId, 'b')).afterSequence, positions[1]!.afterSequence);
  assert.ok(pending.sequence > positions[0]!.afterSequence);
  assert.equal((await second.plugin.service.consumption(channel.channelId, 'legacy')).afterSequence, pending.sequence,
    'restoration repairs only the missing baseline through the authoritative owner record');
  assert.notEqual((await second.plugin.service.consumption(channel.channelId, 'a')).activationId, positions[0]!.activationId);
});
