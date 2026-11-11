import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioStorage, prepareStudio, type StudioPetRuntime, type StudioStorageConfig } from '@pinpawo/studio-core';
import { createPglitePool } from '../../../tests/support/pglitePool';
import { createChannelPlugin } from './channelPlugin';
import { ChannelService } from './channelService';
import { ChannelTimelineConsumer, type ChannelTimelineBatch } from './channelTimelineConsumer';
import { channelMigrations, KyselyChannelStore, type ChannelDatabase } from './store/kysely';

const owner = { kind: 'human' as const, id: 'owner' };
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('ordinary restart discovers a message written while a restored Pet is assembling', async t => {
  const root = await mkdtemp(join(tmpdir(), 'channel-restore-wake-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = { kind: 'sqlite' as const, path: join(root, 'studio.sqlite') };
  const plugin = createChannelPlugin({ httpRoute: false });
  const first = prepareStudio({ studioId: 'restore-wake', storage, plugins: [plugin],
    definitions: [{ definitionId: 'worker', name: 'Worker' }], assemblePet: async () => runtime(),
  });
  await first.activatePlugins();
  const { channel } = await plugin.service.createChannel(owner, { title: 'Owner' });
  await first.studio.pets.create({ petId: 'pet', name: 'Pet', definitionId: 'worker', channelId: channel.channelId });
  const prior = await plugin.service.consumption(channel.channelId, 'pet');
  await first.studio.shutdown();

  const external = createStudioStorage(storage);
  const store = new KyselyChannelStore(await external.open<ChannelDatabase>('channel', channelMigrations(external.dialect)));
  const entered = deferred(), release = deferred();
  const nextPlugin = createChannelPlugin({ httpRoute: false });
  const restored = prepareStudio({ studioId: 'restore-wake', storage, plugins: [nextPlugin],
    definitions: [{ definitionId: 'worker', name: 'Worker' }],
    assemblePet: async () => { entered.resolve(); await release.promise; return runtime(); },
  });
  const writer = new ChannelService({ store, pets: () => restored.studio.listPets(),
    removePet: async () => { throw new Error('not used'); }, humans: async id => ({ label: id, active: true }) });
  let consumer: ChannelTimelineConsumer | undefined;
  t.after(async () => { release.resolve(); await consumer?.stop(); await restored.studio.shutdown(); await external.close(); });
  const starting = restored.activatePlugins();
  await entered.promise;
  const pending = (await writer.postMessage(owner, channel.channelId, { body: 'during restore' })).message;
  assert.equal(restored.studio.listPets().some(pet => pet.petId === 'pet'), false);
  release.resolve();
  await starting;
  const batches: ChannelTimelineBatch[] = [];
  consumer = new ChannelTimelineConsumer({ service: nextPlugin.service, cooldownMs: 10, consume: async batch => { batches.push(batch); } });
  await consumer.start();
  await until(async () => (await nextPlugin.service.consumption(channel.channelId, 'pet')).afterSequence === pending.sequence);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.progress.afterSequence, prior.afterSequence, 'restart keeps the persisted cursor');
  assert.notEqual(batches[0]!.progress.activationId, prior.activationId, 'restoration fences the prior activation');
  assert.deepEqual(batches[0]!.messages.map(message => message.sequence), [pending.sequence]);
});
async function until(check: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 300; n++) {
    if (await check()) return;
    await delay(5);
  }
  throw new Error('Timed out waiting for Channel consumption.');
}
function runtime(): StudioPetRuntime {
  return { close: async () => {}, dispatch: {
    getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
    onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {}, dispatch: async () => {},
  } };
}

for (const [backend, storage] of [
  ['sqlite', () => ({ kind: 'sqlite', path: ':memory:' })],
  ['postgres', () => ({ kind: 'postgres', pool: createPglitePool() })],
] as Array<[string, () => StudioStorageConfig]>) {
  test(`${backend}: a message during assembly is consumed only after successful create becomes live`, async t => {
    const entered = deferred(), release = deferred();
    const plugin = createChannelPlugin({ httpRoute: false });
    const prepared = prepareStudio({ studioId: 'after-live-create', storage: storage(), plugins: [plugin],
      definitions: [{ definitionId: 'worker', name: 'Worker' }],
      assemblePet: async () => { entered.resolve(); await release.promise; return runtime(); },
    });
    await prepared.activatePlugins();
    const service = plugin.service;
    const { channel } = await service.createChannel(owner, { title: 'Owner' });
    const batches: ChannelTimelineBatch[] = [];
    const consumer = new ChannelTimelineConsumer({ service, cooldownMs: 10, consume: async batch => { batches.push(batch); } });
    t.after(async () => { release.resolve(); await consumer.stop(); await prepared.studio.shutdown(); });
    await consumer.start();
    const creating = prepared.studio.pets.create({ petId: 'pet', name: 'Pet', definitionId: 'worker', channelId: channel.channelId });
    await entered.promise;
    const pending = (await service.postMessage(owner, channel.channelId, { body: 'arrived during assembly' })).message;
    await delay(35);
    assert.equal(batches.length, 0, 'the assembly transition must remain unavailable to the consumer');
    release.resolve();
    await creating;
    await until(async () => (await service.consumption(channel.channelId, 'pet')).afterSequence === pending.sequence);
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0]!.messages.map(message => message.sequence), [pending.sequence]);
  });

  test(`${backend}: failed first assembly keeps a closed identity and never wakes the consumer`, async t => {
    const entered = deferred(), release = deferred();
    const plugin = createChannelPlugin({ httpRoute: false });
    const prepared = prepareStudio({ studioId: 'failed-create-wake', storage: storage(), plugins: [plugin],
      definitions: [{ definitionId: 'worker', name: 'Worker' }],
      assemblePet: async () => { entered.resolve(); await release.promise; throw new Error('assembly failed'); },
    });
    await prepared.activatePlugins();
    const service = plugin.service;
    const { channel } = await service.createChannel(owner, { title: 'Owner' });
    let calls = 0;
    const consumer = new ChannelTimelineConsumer({ service, cooldownMs: 10, consume: async () => { calls++; } });
    t.after(async () => { release.resolve(); await consumer.stop(); await prepared.studio.shutdown(); });
    await consumer.start();
    const creating = prepared.studio.pets.create({ petId: 'pet', name: 'Pet', definitionId: 'worker', channelId: channel.channelId });
    const rejected = assert.rejects(creating, /assembly failed/);
    await entered.promise;
    const message = (await service.postMessage(owner, channel.channelId, { body: 'must remain pending' })).message;
    release.resolve();
    await rejected;
    await delay(35);
    assert.ok((await prepared.studio.pets.get('pet'))?.closedAt);
    assert.equal(prepared.studio.listPets().some(pet => pet.petId === 'pet'), false);
    assert.equal(calls, 0);
    const progress = await service.store.getConsumption(channel.channelId, 'pet');
    assert.ok(progress && progress.afterSequence < message.sequence, 'failed creation does not discard the message');
  });
}
