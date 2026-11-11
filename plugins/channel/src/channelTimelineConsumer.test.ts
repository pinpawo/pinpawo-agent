import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioStorage, prepareStudio, type StudioStorageConfig } from '@pinpawo/studio-core';
import { createPglitePool } from '../../../tests/support/pglitePool';
import { createChannelPlugin } from './channelPlugin';
import { enrollChannelInstance } from './channelInstanceConsumption';
import { ChannelService, type ChannelMessage } from './channelService';
import { ChannelTimelineConsumer, type ChannelTimelineBatch } from './channelTimelineConsumer';
import { KyselyChannelStore, channelMigrations, type ChannelDatabase } from './store/kysely';

const owner = { kind: 'human' as const, id: 'owner' };
const alpha = { kind: 'pet' as const, id: 'alpha' };
const humans = async (id: string) => ({ label: id, active: true });
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await check()) return;
    await delay(5);
  }
  throw new Error('Timed out waiting for Timeline consumption.');
}

const backends: Array<[string, () => StudioStorageConfig]> = [
  ['sqlite', () => ({ kind: 'sqlite', path: ':memory:' })],
  ['postgres', () => ({ kind: 'postgres', pool: createPglitePool() })],
];
for (const [backend, config] of backends) {
  async function fixture(t: test.TestContext, initialPets = ['alpha', 'beta']) {
    const plugin = createChannelPlugin({ httpRoute: false });
    const prepared = prepareStudio({ studioId: 'timeline', storage: config(), plugins: [plugin],
      definitions: [{ definitionId: 'worker', name: 'Worker' }],
      assemblePet: async () => ({ close: async () => {}, dispatch: {
        getQueueSnapshot: () => ({ state: 'open' as const, activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
        onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {}, dispatch: async () => {},
      } }),
    });
    await prepared.activatePlugins();
    const service = plugin.service;
    const store = service.store;
    const { channel } = await service.createChannel(owner, { title: 'Timeline' });
    const createPet = (petId: string, channelId = channel.channelId) => prepared.studio.pets.create({
      petId, channelId, definitionId: 'worker', name: petId,
    });
    for (const petId of initialPets) await createPet(petId);
    const pets = () => prepared.studio.listPets();
    const closePet = (petId = 'alpha') => prepared.studio.pets.closeInstance(petId, { confirmStop: true });
    const reopenPet = (petId = 'alpha') => prepared.studio.pets.reopenInstance(petId);
    const removePet = (petId: string) => prepared.studio.pets.removeInstance(petId, { confirmStop: true });
    const consumers: ChannelTimelineConsumer[] = [];
    const consumer = (options: Omit<ConstructorParameters<typeof ChannelTimelineConsumer>[0], 'service'>) => {
      const value = new ChannelTimelineConsumer({ service, cooldownMs: 10, ...options });
      consumers.push(value);
      return value;
    };
    t.after(async () => {
      await Promise.all(consumers.map(value => value.stop()));
      await prepared.studio.shutdown();
    });
    const post = (body: string) => service.postMessage(owner, channel.channelId, { body });
    return { store, service, channelId: channel.channelId, consumer, post, pets, removePet, createPet, closePet, reopenPet };
  }

  test(`${backend}: migration ignores legacy raw Pet memberships without rewriting messages`, async () => {
    const storage = createStudioStorage(config());
    try {
      const migrations = channelMigrations(storage.dialect);
      const old = await storage.open<ChannelDatabase>('channel', {
        '0001_channels': migrations['0001_channels']!, '0002_channel_prompt': migrations['0002_channel_prompt']!,
      });
      await old.insertInto('channels').values(['a', 'b'].map(id => ({
        channel_id: id, title: id, description: null, prompt: null,
        created_by_kind: 'human' as const, created_by_id: 'owner', created_at: 'then', updated_at: 'then',
      }))).execute();
      await old.insertInto('channel_members').values([
        { channel_id: 'a', member_kind: 'pet', member_id: 'alpha', joined_at: 'join-a', left_at: null },
        { channel_id: 'a', member_kind: 'pet', member_id: 'beta', joined_at: 'old-join', left_at: 'left' },
        { channel_id: 'b', member_kind: 'pet', member_id: 'alpha', joined_at: 'join-b', left_at: null },
        { channel_id: 'a', member_kind: 'human', member_id: 'owner', joined_at: 'then', left_at: null },
      ]).execute();
      await old.insertInto('channel_messages').values({
        channel_id: 'a', message_id: 'original', author_kind: 'human', author_id: 'owner', occurred_at: 'then',
        external_ref: null, data: JSON.stringify({ body: 'Keep exactly this.', mentions: [] }),
      }).execute();
      const before = await old.selectFrom('channel_messages').selectAll().execute();
      const db = await storage.open<ChannelDatabase>('channel', migrations);
      const store = new KyselyChannelStore(db);
      assert.equal(await store.getConsumption('a', 'alpha'), undefined);
      assert.equal(await store.getConsumption('b', 'alpha'), undefined);
      assert.equal(await store.getConsumption('a', 'beta'), undefined);
      assert.equal(await store.getConsumption('a', 'owner'), undefined);
      assert.deepEqual(await db.selectFrom('channel_messages').selectAll().execute(), before);
    } finally { await storage.close(); }
  });

  test(`${backend}: progress is independent per owned instance, with monotone compare-and-set acknowledgement`, async t => {
    const { service, channelId, post, createPet } = await fixture(t);
    const initial = await service.consumption(channelId, 'alpha');
    assert.equal(initial.afterSequence, 0);
    const first = (await post('first')).message;
    const second = (await post('second')).message;
    assert.equal(await service.advanceConsumption(initial, first.sequence), true);
    assert.equal(await service.advanceConsumption(initial, second.sequence), false, 'a stale batch cannot skip newer progress');
    assert.equal((await service.consumption(channelId, 'beta')).afterSequence, 0);
    const current = await service.consumption(channelId, 'alpha');
    await assert.rejects(service.advanceConsumption(current, first.sequence), RangeError);
    await assert.rejects(service.advanceConsumption(current, Number.NaN));
    await service.addMember(owner, channelId, alpha);
    assert.deepEqual(await service.consumption(channelId, 'alpha'), current, 'adding a current member does not reset it');
    await service.removeMember(owner, channelId, alpha, { confirmStop: true });
    assert.equal(await service.advanceConsumption(current, second.sequence), false);
    const duringAbsence = (await post('after permanent removal')).message;
    await assert.rejects(service.addMember(owner, channelId, alpha), /not an instance/);
    await createPet('gamma');
    assert.equal((await service.consumption(channelId, 'gamma')).afterSequence, duringAbsence.sequence);
    assert.equal(await service.advanceConsumption(current, second.sequence), false, 'a permanently removed instance cannot acknowledge');
  });

  test(`${backend}: public appends acquire the Channel lock before allocating their sequence`, async t => {
    const { service, store, channelId, pets, removePet } = await fixture(t, ['alpha']);
    const order: string[] = [];
    const wrapped = new Proxy(store, {
      get(target, key) {
        if (key === 'transaction') return (run: (value: typeof store) => Promise<unknown>) => target.transaction(trx => run(new Proxy(trx, {
          get(transaction, method) {
            if (method === 'lockChannel') return async (id: string) => { order.push('lock'); return transaction.lockChannel(id); };
            if (method === 'appendMessage') return async (...args: Parameters<typeof store.appendMessage>) => {
              order.push('append'); return transaction.appendMessage(...args);
            };
            const value = Reflect.get(transaction, method);
            return typeof value === 'function' ? value.bind(transaction) : value;
          },
        }) as typeof store));
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const serialized = new ChannelService({ store: wrapped, pets, removePet, humans });
    await serialized.postMessage(owner, channelId, { body: 'commit-order guard' });
    assert.deepEqual(order, ['lock', 'append']);
    assert.equal((await service.readContext(owner, channelId)).messages.length, 1);
  });

  test(`${backend}: one fixed cooldown coalesces original messages and each Pet consumes them independently`, async t => {
    const { service, channelId, consumer, post } = await fixture(t);
    const seen: ChannelTimelineBatch[] = [];
    const queue = consumer({ cooldownMs: 40, consume: async batch => { seen.push(batch); } });
    await queue.start();
    const first = (await post('first')).message;
    const second = (await service.postMessage(alpha, channelId, {
      body: 'second', replyTo: first.messageId, mentions: [{ participantId: 'pet:beta' }],
      deliverables: [{ uri: 'https://example.test/public.pdf', title: 'Public' }],
    })).message;
    const third = (await post('third')).message;
    await until(async () => (await service.consumption(channelId, 'beta')).afterSequence === third.sequence);
    assert.equal(seen.length, 2);
    assert.deepEqual(new Set(seen.map(batch => batch.progress.petId)), new Set(['alpha', 'beta']));
    for (const batch of seen) {
      assert.deepEqual(batch.messages, [first, second, third]);
      assert.equal(batch.throughSequence, third.sequence);
    }
    assert.equal((await service.listSessions(owner, channelId)).length, 0, 'scheduling and acknowledgement allocate no sessions');
  });

  test(`${backend}: repeated wakes retain the first cooldown timer instead of sliding its deadline`, async t => {
    const { consumer, channelId, post } = await fixture(t, ['alpha']);
    const schedule = t.mock.method(globalThis, 'setTimeout');
    const queue = consumer({ cooldownMs: 17_393, consume: async () => {} });
    await queue.start();
    await post('first');
    await queue.wake(channelId);
    await post('second');
    await queue.wake(channelId);
    assert.equal(schedule.mock.calls.filter(call => call.arguments[1] === 17_393).length, 1);
    await queue.stop();
  });

  test(`${backend}: a batch freezes its end and never acknowledges posts or replies created during processing`, async t => {
    const hold = deferred();
    t.after(() => hold.resolve());
    const { service, channelId, consumer, post } = await fixture(t, ['alpha']);
    const batches: ChannelTimelineBatch[] = [];
    const queue = consumer({ consume: async batch => { batches.push(batch); if (batches.length === 1) await hold.promise; } });
    const first = (await post('first')).message;
    await queue.start();
    await until(() => batches.length === 1);
    const second = (await post('arrived during processing')).message;
    const reply = (await service.postMessage(alpha, channelId, { body: 'Public reply.' })).message;
    assert.equal((await service.consumption(channelId, 'alpha')).afterSequence, 0);
    hold.resolve();
    await until(async () => (await service.consumption(channelId, 'alpha')).afterSequence === reply.sequence);
    assert.deepEqual(batches.map(batch => batch.messages.map(message => message.sequence)), [[first.sequence], [second.sequence, reply.sequence]]);
    assert.equal(batches[1]!.progress.afterSequence, first.sequence);
  });

  test(`${backend}: bounded pages preserve order and do not assume Channel sequence values are contiguous`, async t => {
    const { service, channelId, consumer, post } = await fixture(t, ['alpha']);
    const other = (await service.createChannel(owner, { title: 'Other', pets: [] })).channel;
    const messages: ChannelMessage[] = [];
    for (let i = 0; i < 7; i++) {
      messages.push((await post(`message ${i}`)).message);
      await service.postMessage(owner, other.channelId, { body: `gap ${i}` });
    }
    const batches: ChannelTimelineBatch[] = [];
    const queue = consumer({ batchLimit: 2, consume: async batch => { batches.push(batch); } });
    await queue.start();
    await until(async () => (await service.consumption(channelId, 'alpha')).afterSequence === messages.at(-1)!.sequence);
    assert.deepEqual(batches.map(batch => batch.messages.length), [2, 2, 2, 1]);
    assert.deepEqual(batches.flatMap(batch => batch.messages), messages);
  });

  test(`${backend}: duplicate external messages and overlapping wakes do not repeat or overlap a successful batch`, async t => {
    const { service, channelId, consumer } = await fixture(t, ['alpha']);
    const first = await service.postMessage(alpha, channelId, { body: 'Original' }, { externalRef: 'external' });
    const duplicate = await service.postMessage(alpha, channelId, { body: 'Changed replay' }, { externalRef: 'external' });
    assert.equal(duplicate.created, false);
    let running = 0;
    let calls = 0;
    const queue = consumer({ consume: async () => { running++; calls++; assert.equal(running, 1); await delay(25); running--; } });
    await queue.start();
    await Promise.all(Array.from({ length: 25 }, () => queue.wake(channelId)));
    await until(async () => (await service.consumption(channelId, 'alpha')).afterSequence === first.message.sequence);
    await delay(50);
    assert.equal(calls, 1);
  });

  test(`${backend}: one failed Head keeps its cursor and does not block another Pet or retry automatically`, async t => {
    const { service, channelId, consumer, post } = await fixture(t);
    let alphaCalls = 0;
    let fail = true;
    const failures: unknown[] = [];
    const queue = consumer({
      consume: async batch => {
        if (batch.progress.petId !== 'alpha') return;
        alphaCalls++;
        if (fail) throw new Error('failed processing');
      },
      onError: ({ error }) => { failures.push(error); throw new Error('reporting also failed'); },
    });
    const message = (await post('work')).message;
    await queue.start();
    await until(async () => (await service.consumption(channelId, 'beta')).afterSequence === message.sequence && failures.length === 1);
    await delay(50);
    assert.equal(alphaCalls, 1);
    assert.equal((await service.consumption(channelId, 'alpha')).afterSequence, 0);
    fail = false;
    await queue.wake(channelId);
    await until(async () => (await service.consumption(channelId, 'alpha')).afterSequence === message.sequence);
    assert.equal(alphaCalls, 2);
  });

  test(`${backend}: Close aborts a batch before final lifecycle events and Reopen replaces its activation without moving progress`, async t => {
    const hold = deferred();
    t.after(() => hold.resolve());
    const { service, store, channelId, consumer, post, closePet, reopenPet } = await fixture(t, ['alpha']);
    const batches: ChannelTimelineBatch[] = [];
    const queue = consumer({ consume: async batch => { batches.push(batch); if (batches.length === 1) await hold.promise; } });
    const message = (await post('old activation')).message;
    await queue.start();
    await until(() => batches.length === 1);
    const old = batches[0]!.progress;
    await closePet();
    assert.equal(batches[0]!.signal.aborted, true);
    assert.equal((await store.getConsumption(channelId, 'alpha'))?.afterSequence, old.afterSequence);
    await reopenPet();
    const fresh = await service.consumption(channelId, 'alpha');
    assert.notEqual(fresh.activationId, old.activationId);
    assert.equal(fresh.afterSequence, old.afterSequence);
    assert.equal(await service.advanceConsumption(old, message.sequence), false);
    await until(async () => (await service.consumption(channelId, 'alpha')).afterSequence === message.sequence);
    assert.equal(batches.length, 2, 'Reopen wakes the preserved backlog after becoming live');
    assert.equal(batches[1]!.progress.activationId, fresh.activationId);
    hold.resolve();
    await delay(30);
    assert.equal((await service.consumption(channelId, 'alpha')).afterSequence, message.sequence, 'the stale callback cannot acknowledge or reset fresh progress');
  });

  test(`${backend}: an aborted activation rejecting cannot erase an explicit fresh activation wake`, async t => {
    const old = deferred();
    t.after(() => old.resolve());
    const { service, channelId, consumer, post } = await fixture(t, ['alpha']);
    const batches: ChannelTimelineBatch[] = [];
    const queue = consumer({ consume: async batch => {
      batches.push(batch);
      if (batches.length === 1) {
        await old.promise;
        batch.signal.throwIfAborted();
      }
    } });
    await post('old activation');
    await queue.start();
    await until(() => batches.length === 1);
    // Explicit facility-level activation, not a product Reopen consumption policy.
    service.invalidateConsumption(channelId, 'alpha');
    await enrollChannelInstance(service.store, { channelId, petId: 'alpha' });
    const message = (await post('new activation')).message;
    // Let the async message/explicit wakes settle while the aborted callback
    // still holds the slot, then reject exactly that old callback.
    await queue.wake(channelId);
    old.resolve();
    await until(async () => (await service.consumption(channelId, 'alpha')).afterSequence === message.sequence);
    assert.equal(batches[1]!.messages.at(-1)!.messageId, message.messageId);
  });

  test(`${backend}: 100 wakes during processing coalesce while another Pet remains independent`, async t => {
    const hold = deferred();
    t.after(() => hold.resolve());
    const { service, channelId, consumer, post } = await fixture(t);
    const batches: ChannelTimelineBatch[] = [];
    let alphaRunning = 0;
    const queue = consumer({ consume: async batch => {
      batches.push(batch);
      if (batch.progress.petId !== 'alpha') return;
      assert.equal(++alphaRunning, 1);
      if (batches.filter(value => value.progress.petId === 'alpha').length === 1) await hold.promise;
      alphaRunning--;
    } });
    const first = (await post('first')).message;
    await queue.start();
    await until(() => alphaRunning === 1);
    const last = (await post('during alpha processing')).message;
    await Promise.all(Array.from({ length: 100 }, () => queue.wake(channelId)));
    await until(async () => (await service.consumption(channelId, 'beta')).afterSequence === last.sequence);
    assert.equal(batches.filter(batch => batch.progress.petId === 'alpha').length, 1);
    assert.equal((await service.consumption(channelId, 'alpha')).afterSequence, 0);
    hold.resolve();
    await until(async () => (await service.consumption(channelId, 'alpha')).afterSequence === last.sequence);
    await delay(30);
    assert.deepEqual(batches.filter(batch => batch.progress.petId === 'alpha')
      .map(batch => batch.messages.map(message => message.sequence)), [[first.sequence], [last.sequence]]);
  });

  test(`${backend}: a wake during a failed attempt waits for a later explicit wake`, async t => {
    const hold = deferred();
    t.after(() => hold.resolve());
    const { service, channelId, consumer, post } = await fixture(t, ['alpha']);
    let calls = 0;
    let fail = true;
    const failures: unknown[] = [];
    const queue = consumer({
      consume: async () => { calls++; if (fail) { await hold.promise; throw new Error('failed after wake'); } },
      onError: ({ error }) => { failures.push(error); },
    });
    await post('first');
    await queue.start();
    await until(() => calls === 1);
    const last = (await post('dirty while failing')).message;
    await queue.wake(channelId);
    hold.resolve();
    await until(() => failures.length === 1);
    await delay(30);
    assert.equal(calls, 1, 'the failed attempt does not requeue its dirty wake');
    assert.equal((await service.consumption(channelId, 'alpha')).afterSequence, 0);
    fail = false;
    await queue.wake(channelId);
    await until(async () => (await service.consumption(channelId, 'alpha')).afterSequence === last.sequence);
    assert.equal(failures.length, 1);
  });

  test(`${backend}: an ignored abort cannot block or corrupt a fresh activation`, async t => {
    const hold = deferred();
    t.after(() => hold.resolve());
    const { service, channelId, consumer, post } = await fixture(t, ['alpha']);
    const batches: ChannelTimelineBatch[] = [];
    const queue = consumer({ consume: async batch => {
      batches.push(batch);
      if (batches.length === 1) await hold.promise;
    } });
    await post('old activation');
    await queue.start();
    await until(() => batches.length === 1);
    // Explicit facility-level activation, not a product Reopen consumption policy.
    service.invalidateConsumption(channelId, 'alpha');
    await enrollChannelInstance(service.store, { channelId, petId: 'alpha' });
    const baseline = await service.consumption(channelId, 'alpha');
    const last = (await post('new activation')).message;
    await queue.wake(channelId);
    await until(async () => (await service.consumption(channelId, 'alpha')).afterSequence === last.sequence);
    assert.equal(batches[0]!.signal.aborted, true);
    assert.equal(batches.length, 2, 'fresh activation proceeds even while the old callback is blocked');
    assert.equal(batches[1]!.progress.activationId, baseline.activationId);
    assert.equal(batches[1]!.messages.at(-1)!.messageId, last.messageId);
    hold.resolve();
    await delay(30);
    assert.equal((await service.consumption(channelId, 'alpha')).afterSequence, last.sequence);
  });

  for (const cancellation of ['close', 'stop'] as const) {
    test(`${backend}: ${cancellation} during the final activation read never starts the callback`, async t => {
      const paused = deferred();
      const release = deferred();
      t.after(() => release.resolve());
      const { service, store, channelId, consumer, post, closePet } = await fixture(t, ['alpha']);
      const message = (await post('pending')).message;
      const getConsumption = store.getConsumption.bind(store);
      let reads = 0;
      t.mock.method(store, 'getConsumption', async (...args: Parameters<typeof getConsumption>) => {
        const snapshot = await getConsumption(...args);
        if (++reads === 2) { paused.resolve(); await release.promise; }
        return snapshot;
      });
      let calls = 0;
      const queue = consumer({ consume: async () => { calls++; } });
      await queue.start();
      await paused.promise;
      if (cancellation === 'close') {
        await closePet();
        release.resolve();
        await delay(30);
        assert.equal(calls, 0, 'Close fences the callback before stopping the consumer');
        assert.equal((await store.getConsumption(channelId, 'alpha'))?.afterSequence, 0);
        await assert.rejects(service.consumption(channelId, 'alpha'));
        return;
      }
      let stopped = false;
      const stopping = queue.stop().then(() => { stopped = true; });
      await delay(15);
      assert.equal(stopped, false, 'stop waits for real preparation to settle');
      release.resolve();
      await stopping;
      assert.equal(calls, 0);
      assert.equal((await service.consumption(channelId, 'alpha')).afterSequence, 0);
      const restarted = consumer({ consume: async batch => { assert.deepEqual(batch.messages, [message]); calls++; } });
      await restarted.start();
      await until(async () => (await service.consumption(channelId, 'alpha')).afterSequence === message.sequence);
      assert.equal(calls, 1);
    });
  }

  test(`${backend}: stopping clears waiting windows and waits for an ignoring callback`, async t => {
    const hold = deferred();
    t.after(() => hold.resolve());
    const { service, channelId, consumer, post, createPet } = await fixture(t, ['alpha']);
    const other = (await service.createChannel(owner, { title: 'Waiting' })).channel;
    await createPet('waiting', other.channelId);
    let calls = 0;
    let batch: ChannelTimelineBatch | undefined;
    const queue = consumer({ cooldownMs: 40, consume: async value => { calls++; batch = value; await hold.promise; } });
    const message = (await post('running')).message;
    await queue.start();
    await until(() => calls === 1);
    await service.postMessage(owner, other.channelId, { body: 'waiting' });
    await queue.wake(other.channelId);
    let stopped = false;
    const stopping = queue.stop().then(() => { stopped = true; });
    await delay(60);
    assert.equal(batch!.signal.aborted, true);
    assert.equal(stopped, false);
    assert.equal(calls, 1, 'the waiting Channel must not begin after stop');
    hold.resolve();
    await stopping;
    assert.equal((await service.consumption(channelId, 'alpha')).afterSequence, 0);
    assert.ok(message.sequence > 0);
  });

  test(`${backend}: stopping aborts processing without acknowledging, and a new consumer finds pending rows`, async t => {
    const hold = deferred();
    t.after(() => hold.resolve());
    const { service, channelId, consumer, post } = await fixture(t, ['alpha']);
    let batch: ChannelTimelineBatch | undefined;
    const first = consumer({ consume: async value => { batch = value; await hold.promise; } });
    const message = (await post('pending')).message;
    await first.start();
    await until(() => !!batch);
    const stopping = first.stop();
    assert.equal(batch!.signal.aborted, true);
    hold.resolve();
    await stopping;
    assert.equal((await service.consumption(channelId, 'alpha')).afterSequence, 0);
    await assert.rejects(first.start(), /stopped/);
    const second = consumer({ consume: async () => {} });
    await second.start();
    await until(async () => (await service.consumption(channelId, 'alpha')).afterSequence === message.sequence);
  });
}

test('SQLite restart preserves independent Pet cursors without replaying acknowledged rows', async t => {
  const root = await mkdtemp(join(tmpdir(), 'channel-consumption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { kind: 'sqlite' as const, path: join(root, 'studio.sqlite') };
  const live: Array<{ petId: string; name: string; channelId: string; createdAt: string }> = [];
  const pets = () => live;
  const removePet = async () => {};
  const open = async () => {
    const storage = createStudioStorage(config);
    const store = new KyselyChannelStore(await storage.open<ChannelDatabase>('channel', channelMigrations(storage.dialect)));
    return { storage, service: new ChannelService({ store, pets, removePet, humans }) };
  };
  const first = await open();
  const { channel } = await first.service.createChannel(owner, { title: 'Persistent' });
  for (const petId of ['alpha', 'beta']) {
    await enrollChannelInstance(first.service.store, { channelId: channel.channelId, petId });
    live.push({ petId, name: petId, channelId: channel.channelId, createdAt: channel.createdAt });
  }
  const old = (await first.service.postMessage(owner, channel.channelId, { body: 'acknowledged' })).message;
  await first.service.advanceConsumption(await first.service.consumption(channel.channelId, 'alpha'), old.sequence);
  const pending = (await first.service.postMessage(owner, channel.channelId, { body: 'still pending' })).message;
  await first.storage.close();
  const second = await open();
  const seen: ChannelTimelineBatch[] = [];
  const consumer = new ChannelTimelineConsumer({ service: second.service, cooldownMs: 0, consume: async batch => { seen.push(batch); } });
  try {
    await consumer.start();
    await until(async () => (await second.service.consumption(channel.channelId, 'alpha')).afterSequence === pending.sequence
      && (await second.service.consumption(channel.channelId, 'beta')).afterSequence === pending.sequence);
    assert.deepEqual(seen.filter(batch => batch.progress.petId === 'alpha').flatMap(batch => batch.messages), [pending]);
    assert.deepEqual(seen.filter(batch => batch.progress.petId === 'beta').flatMap(batch => batch.messages), [old, pending]);
  } finally { await consumer.stop(); await second.storage.close(); }
});

test('Timeline consumer rejects invalid scheduling bounds before starting work', () => {
  const base = { service: {} as ChannelService, consume: async () => {} };
  for (const cooldownMs of [-1, 0.5, 60_001, Infinity]) assert.throws(() => new ChannelTimelineConsumer({ ...base, cooldownMs }), RangeError);
  for (const batchLimit of [0, 0.5, 201, NaN]) assert.throws(() => new ChannelTimelineConsumer({ ...base, batchLimit }), RangeError);
});

// PGlite runs one serialized connection. This optional server test exercises
// sequence allocation and commit order using independent Postgres connections.
const postgresUrl = process.env.PINPAWO_TEST_POSTGRES_URL;
test('postgres server: a later append cannot commit past an uncommitted lower Channel sequence', {
  skip: !postgresUrl && 'PINPAWO_TEST_POSTGRES_URL is not set',
}, async () => {
  const { default: pg } = await import('pg');
  const database = `channel_consumer_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: postgresUrl });
  await admin.connect();
  await admin.query(`create database ${database}`);
  const url = new URL(postgresUrl!);
  url.pathname = '/' + database;
  const storage = createStudioStorage({ kind: 'postgres', pool: new pg.Pool({ connectionString: url.href, max: 4 }) });
  const inserted = deferred();
  const release = deferred();
  let first: Promise<unknown> | undefined;
  let second: Promise<unknown> | undefined;
  try {
    const store = new KyselyChannelStore(await storage.open<ChannelDatabase>('channel', channelMigrations(storage.dialect)));
    const pets = () => [] as Array<{ petId: string; name: string; channelId: string; createdAt: string }>;
    const removePet = async () => {};
    const base = new ChannelService({ store, pets, removePet, humans });
    const { channel } = await base.createChannel(owner, { title: 'Commit order' });
    const held = Object.create(store, {
      transaction: { value: <T>(work: (inner: typeof store) => Promise<T>) => store.transaction(inner => work(Object.create(inner, {
        appendMessage: { value: async (...args: Parameters<typeof store.appendMessage>) => {
          const row = await inner.appendMessage(...args);
          if (row.body === 'first') { inserted.resolve(); await release.promise; }
          return row;
        } },
      }))) },
    });
    const service = new ChannelService({ store: held, pets, removePet, humans });
    first = service.postMessage(owner, channel.channelId, { body: 'first' });
    await Promise.race([inserted.promise, first]);
    let committedSecond = false;
    second = service.postMessage(owner, channel.channelId, { body: 'second' }).then(result => { committedSecond = true; return result; });
    await delay(100);
    assert.equal(committedSecond, false, 'the later transaction waits on the existing Channel row lock');
    assert.deepEqual((await base.readContext(owner, channel.channelId)).messages, []);
    release.resolve();
    await Promise.all([first, second]);
    const rows = (await base.readContext(owner, channel.channelId)).messages;
    assert.deepEqual(rows.map(row => row.body), ['first', 'second']);
    assert.ok(rows[0]!.sequence < rows[1]!.sequence);
  } finally {
    release.resolve();
    await Promise.allSettled([first, second]);
    await storage.close();
    await admin.query(`drop database if exists ${database}`);
    await admin.end();
  }
});
