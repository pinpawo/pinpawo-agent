import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioStorage, type StudioStorageConfig } from '../../../packages/studio/src/storage/studioStorage';
import { createPglitePool } from '../../../tests/support/pglitePool';
import { ChannelService } from './channelService';
import { KyselyChannelStore, channelMigrations, type ChannelDatabase } from './store/kysely';

const owner = { kind: 'human' as const, id: 'owner' };
const humans = async (id: string) => ({ label: id, active: true });
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

const backends: Array<[string, () => StudioStorageConfig]> = [
  ['sqlite', () => ({ kind: 'sqlite', path: ':memory:' })],
  ['pglite', () => ({ kind: 'postgres', pool: createPglitePool() })],
];

async function open(config: StudioStorageConfig) {
  const storage = createStudioStorage(config);
  const store = new KyselyChannelStore(await storage.open<ChannelDatabase>('channel', channelMigrations(storage.dialect)));
  const service = new ChannelService({ store, pets: () => [], removePet: async () => {}, humans });
  return { storage, service };
}

for (const [backend, config] of backends) {
  test(`${backend}: queue works without Pets and only notifies after a committed append`, async t => {
    const { storage, service } = await open(config());
    t.after(() => storage.close());
    const { channel } = await service.createChannel(owner, { title: 'Queue' });
    const delivered: Promise<string | undefined>[] = [];
    const unsubscribe = service.subscribe(event => {
      if (event.type === 'channel.message.created') {
        delivered.push(service.store.getMessage(channel.channelId, event.payload.messageId).then(row => row?.body));
      }
    });
    assert.equal(await service.queueHead(channel.channelId), 0);
    const first = (await service.postMessage(owner, channel.channelId, { body: 'first' })).message;
    assert.deepEqual(await Promise.all(delivered), ['first']);
    unsubscribe();
    const second = (await service.postMessage(owner, channel.channelId, { body: 'second' })).message;
    assert.equal(delivered.length, 1);
    assert.equal(await service.queueHead(channel.channelId), second.sequence);
    const rows = await service.queueRead(channel.channelId, { after: 0, limit: 10 });
    assert.deepEqual(rows.items.map(row => row.sequence), [first.sequence, second.sequence]);
  });

  test(`${backend}: a captured upper bound freezes a paginated batch`, async t => {
    const { storage, service } = await open(config());
    t.after(() => storage.close());
    const { channel } = await service.createChannel(owner, { title: 'Queue' });
    const first = (await service.postMessage(owner, channel.channelId, { body: 'first' })).message;
    const second = (await service.postMessage(owner, channel.channelId, { body: 'second' })).message;
    const upper = await service.queueHead(channel.channelId);
    const page1 = await service.queueRead(channel.channelId, { after: 0, through: upper, limit: 1 });
    const third = (await service.postMessage(owner, channel.channelId, { body: 'third' })).message;
    const page2 = await service.queueRead(channel.channelId, { after: page1.nextAfter, through: upper, limit: 1 });
    assert.deepEqual(page1.items.map(row => row.sequence), [first.sequence]);
    assert.equal(page1.hasMore, true);
    assert.deepEqual(page2.items.map(row => row.sequence), [second.sequence]);
    assert.equal(page2.hasMore, false);
    assert.deepEqual((await service.queueRead(channel.channelId, { after: upper, limit: 10 })).items.map(row => row.sequence), [third.sequence]);
  });

  test(`${backend}: independent cursors advance only on explicit successful compare-and-set`, async t => {
    const { storage, service } = await open(config());
    t.after(() => storage.close());
    const { channel } = await service.createChannel(owner, { title: 'Queue' });
    const first = (await service.postMessage(owner, channel.channelId, { body: 'first' })).message;
    const second = (await service.postMessage(owner, channel.channelId, { body: 'second' })).message;
    await assert.rejects(service.queueCursor(channel.channelId, 'too-far', second.sequence + 1), RangeError);
    const a = await service.queueCursor(channel.channelId, 'reader-a', 0);
    const b = await service.queueCursor(channel.channelId, 'reader-b', first.sequence);
    assert.deepEqual([a.afterSequence, b.afterSequence], [0, first.sequence]);
    // An interrupted or failed handler never acknowledges its read batch.
    await service.queueRead(channel.channelId, { after: a.afterSequence, through: second.sequence, limit: 10 });
    assert.equal((await service.queueCursor(channel.channelId, 'reader-a', second.sequence)).afterSequence, 0);
    assert.equal(await service.advanceQueueCursor(a, first.sequence), true);
    assert.equal(await service.advanceQueueCursor(a, second.sequence), false);
    assert.equal((await service.queueCursor(channel.channelId, 'reader-b', 0)).afterSequence, first.sequence);
    const current = await service.queueCursor(channel.channelId, 'reader-a', 0);
    await assert.rejects(service.advanceQueueCursor(current, first.sequence), RangeError);
    await assert.rejects(service.advanceQueueCursor(current, Number.NaN));
    await assert.rejects(service.advanceQueueCursor(current, second.sequence + 1), RangeError);
    assert.equal((await service.queueCursor(channel.channelId, 'reader-a', 0)).afterSequence, first.sequence);
  });
}

test('SQLite restart preserves independent queue progress and pending messages', async t => {
  const root = await mkdtemp(join(tmpdir(), 'channel-queue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { kind: 'sqlite' as const, path: join(root, 'studio.sqlite') };
  const first = await open(config);
  const { channel } = await first.service.createChannel(owner, { title: 'Persistent queue' });
  const a = await first.service.queueCursor(channel.channelId, 'reader-a', 0);
  await first.service.queueCursor(channel.channelId, 'reader-b', 0);
  const done = (await first.service.postMessage(owner, channel.channelId, { body: 'done' })).message;
  assert.equal(await first.service.advanceQueueCursor(a, done.sequence), true);
  const pending = (await first.service.postMessage(owner, channel.channelId, { body: 'pending' })).message;
  await first.storage.close();
  const second = await open(config);
  t.after(() => second.storage.close());
  const restoredA = await second.service.queueCursor(channel.channelId, 'reader-a', 0);
  const restoredB = await second.service.queueCursor(channel.channelId, 'reader-b', pending.sequence);
  assert.deepEqual([restoredA.afterSequence, restoredB.afterSequence], [done.sequence, 0]);
  assert.deepEqual((await second.service.queueRead(channel.channelId, { after: restoredA.afterSequence, limit: 10 })).items.map(row => row.body), ['pending']);
  assert.deepEqual((await second.service.queueRead(channel.channelId, { after: restoredB.afterSequence, limit: 10 })).items.map(row => row.body), ['done', 'pending']);
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
