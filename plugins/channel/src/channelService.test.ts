import assert from 'node:assert/strict';
import test from 'node:test';
import { sql } from 'kysely';
import {
  KyselyClientStore, StudioClients, clientMigrations, createStudioStorage, type ClientDatabase, type StudioStorageConfig,
} from '@pinpawo/studio-core';
import { createPglitePool } from '../../../tests/support/pglitePool';
import { ChannelAccessError, ChannelLastHumanError, ChannelNotFoundError, ChannelService } from './channelService';
import type { ChannelStore, MemberRef } from './store/channelStore';
import { KyselyChannelStore, channelMigrations, type ChannelDatabase } from './store/kysely';

const owner: MemberRef = { kind: 'human', id: 'owner' };
const guest: MemberRef = { kind: 'human', id: 'guest' };
const executor: MemberRef = { kind: 'pet', id: 'executor' };
const pets = () => [{ petId: 'executor', name: 'Executor' }, { petId: 'reviewer', name: 'Reviewer' }];
/** Studio clients as Channel sees them: `retired` is revoked. */
const clients = new Map([['owner', 'owner'], ['guest', 'guest'], ['retired', 'Retired']]);
const humans = async (id: string) => clients.has(id) ? { label: clients.get(id)!, active: id !== 'retired' } : undefined;

const backends: Array<[string, () => StudioStorageConfig]> = [
  ['sqlite', () => ({ kind: 'sqlite', path: ':memory:' })],
  ['postgres', () => ({ kind: 'postgres', pool: createPglitePool() })],
];

for (const [backend, config] of backends) {
  /** A Channel service on a fresh database of this backend. */
  async function withService(run: (service: ChannelService, store: ChannelStore) => Promise<void>, wrap = (store: ChannelStore) => store) {
    const storage = createStudioStorage(config());
    try {
      const store = new KyselyChannelStore(await storage.open<ChannelDatabase>('channel', channelMigrations(storage.dialect)));
      await run(new ChannelService({ store: wrap(store), pets, humans }), store);
    } finally { await storage.close(); }
  }

  test(`${backend}: Channel prompt is owned by the Channel, visible to members and can be replaced or cleared`, () => withService(async (service) => {
    const { channel } = await service.createChannel(owner, {
      title: 'Team', description: 'Purpose', prompt: '  Work together.\nAsk when uncertain.  ', pets: ['executor'],
    }, { studio: true });
    assert.equal(channel.prompt, 'Work together.\nAsk when uncertain.');
    assert.equal((await service.readContext(executor, channel.channelId)).channel.prompt, channel.prompt);
    assert.equal((await service.listChannels(owner)).channels[0]?.prompt, channel.prompt);
    await assert.rejects(service.readContext(guest, channel.channelId), ChannelAccessError);
    await assert.rejects(service.updateChannel(guest, channel.channelId, { prompt: 'forged' }), ChannelAccessError);
    const updated = await service.updateChannel(owner, channel.channelId, { prompt: 'Updated instructions' }, { studio: true });
    assert.equal(updated.prompt, 'Updated instructions');
    assert.equal(updated.description, 'Purpose');
    assert.equal((await service.updateChannel(owner, channel.channelId, { prompt: null }, { studio: true })).prompt, undefined);
    assert.equal((await service.updateChannel(owner, channel.channelId, { prompt: '   ' }, { studio: true })).prompt, undefined);
    await assert.rejects(service.updateChannel(owner, channel.channelId, { prompt: 'x'.repeat(50_001) }));
  }));

  test(`${backend}: only Studio authority can set or change a Channel prompt`, () => withService(async (service) => {
    await assert.rejects(service.createChannel(owner, { title: 'Team', prompt: 'Forged', pets: ['executor'] }), ChannelAccessError);
    const { channelId } = (await service.createChannel(owner, { title: 'Team', prompt: 'Original', pets: ['executor'] }, { studio: true })).channel;
    await service.addMember(owner, channelId, guest);
    assert.equal((await service.updateChannel(guest, channelId, { title: 'Renamed', description: 'Updated' })).title, 'Renamed');
    await assert.rejects(service.updateChannel(guest, channelId, { title: 'Should not apply', prompt: 'Forged' }), ChannelAccessError);
    await assert.rejects(service.updateChannel(guest, channelId, { prompt: null }), ChannelAccessError);
    await assert.rejects(service.updateChannel(executor, channelId, { prompt: 'Forged' }), ChannelAccessError);
    assert.equal((await service.readContext(owner, channelId)).channel.title, 'Renamed');
    assert.equal((await service.readContext(owner, channelId)).channel.prompt, 'Original');
    await assert.rejects(service.updateChannel(owner, channelId, { prompt: 'Creator update' }), ChannelAccessError);
    await service.removeMember(guest, channelId, owner);
    await assert.rejects(service.updateChannel(owner, channelId, { prompt: 'Former member' }), ChannelAccessError);
    const admin: MemberRef = { kind: 'human', id: 'local' };
    await assert.rejects(service.updateChannel(admin, channelId, { prompt: 'No authority' }), ChannelAccessError);
    assert.equal((await service.updateChannel(admin, channelId, { prompt: 'Studio update' }, { studio: true })).prompt, 'Studio update');
    assert.equal((await service.updateChannel(admin, channelId, { prompt: null }, { studio: true })).prompt, undefined);
    await assert.rejects(service.updateChannel(admin, channelId, { title: 'Other metadata', prompt: 'Mixed' }, { studio: true }), ChannelAccessError);
  }));

  test(`${backend}: upgrading an existing Channel keeps its messages and does not invent a prompt`, async () => {
    const storage = createStudioStorage(config());
    try {
      const migrations = channelMigrations(storage.dialect);
      const legacy = await storage.open('channel', { '0001_channels': migrations['0001_channels']! });
      await sql`insert into channels (channel_id, title, description, created_by_kind, created_by_id, created_at, updated_at)
        values ('old', 'Existing', 'Preserved', 'human', 'owner', 'then', 'then')`.execute(legacy);
      await sql`insert into channel_members (channel_id, member_kind, member_id, joined_at)
        values ('old', 'human', 'owner', 'then')`.execute(legacy);
      await sql`insert into channel_messages (message_id, channel_id, author_kind, author_id, occurred_at, data)
        values ('old-msg', 'old', 'human', 'owner', 'then', ${JSON.stringify({ body: 'Keep this', mentions: [], artifacts: [] })})`.execute(legacy);
      const db = await storage.open<ChannelDatabase>('channel', migrations);
      const service = new ChannelService({ store: new KyselyChannelStore(db), pets, humans });
      const context = await service.readContext(owner, 'old');
      assert.equal(context.channel.description, 'Preserved');
      assert.equal(context.channel.prompt, undefined);
      assert.equal(context.messages[0]?.body, 'Keep this');
      assert.equal((await service.updateChannel(owner, 'old', { prompt: 'New prompt' }, { studio: true })).prompt, 'New prompt');
    } finally { await storage.close(); }
  });

  test(`${backend}: a Channel starts with its creator and the Pets it names, and lists only for its members`, () => withService(async (service) => {
    const { channel, members } = await service.createChannel(owner, { title: 'Release', description: 'Ship 1.0', pets: ['executor', 'executor'] });
    assert.equal(channel.title, 'Release');
    assert.deepEqual(channel.createdBy, owner);
    assert.deepEqual(members.map(member => [member.participantId, member.label]), [['human:owner', 'owner'], ['pet:executor', 'Executor']]);
    await assert.rejects(service.createChannel(owner, { title: 'No pets field' }));
    await assert.rejects(service.createChannel(owner, { title: 'Unknown', pets: ['ghost'] }), /Unknown Pet/);
    await assert.rejects(service.createChannel(owner, { title: 'Old shape', goal: 'g', scope: 's', pets: [] }));
    const second = (await service.createChannel(owner, { title: 'Second', pets: [] })).channel;
    await service.createChannel(guest, { title: 'Guest only', pets: [] });

    const first = await service.listChannels(owner, { limit: 1 });
    assert.deepEqual(first.channels.map(item => item.channelId), [channel.channelId]);
    assert.equal(first.hasMore, true);
    assert.deepEqual((await service.listChannels(owner, { after: first.nextAfter })).channels.map(item => item.channelId), [second.channelId]);
    assert.deepEqual((await service.listChannels(executor)).channels.map(item => item.channelId), [channel.channelId]);

    const updated = await service.updateChannel(owner, channel.channelId, { description: null });
    assert.equal(updated.description, undefined);
    assert.equal(updated.title, 'Release');
  }));

  test(`${backend}: only current members read, speak and manage members; leaving keeps history and rejoining restores access`, () => withService(async (service) => {
    const { channelId } = (await service.createChannel(owner, { title: 'Release', pets: ['executor'] })).channel;
    await assert.rejects(service.readContext(guest, channelId), ChannelAccessError);
    await assert.rejects(service.postMessage(guest, channelId, { body: 'hi' }), ChannelAccessError);
    await assert.rejects(service.addMember(guest, channelId, guest), ChannelAccessError);
    await assert.rejects(service.readContext(owner, 'missing'), ChannelNotFoundError);
    await assert.rejects(service.addMember(owner, channelId, { kind: 'pet', id: 'ghost' }), /Unknown Pet/);
    await assert.rejects(service.addMember(owner, channelId, { kind: 'human', id: 'stranger' }), /Unknown Studio client/);
    await assert.rejects(service.addMember(owner, channelId, { kind: 'human', id: 'retired' }), /Unknown Studio client/);

    const events: string[] = [];
    service.subscribe(event => events.push(event.type));
    assert.equal((await service.addMember(owner, channelId, guest)).participantId, 'human:guest');
    await service.addMember(owner, channelId, guest);
    const { message } = await service.postMessage(guest, channelId, { body: 'Joined.' });
    await service.removeMember(owner, channelId, guest);
    await service.removeMember(owner, channelId, guest);
    await assert.rejects(service.readContext(guest, channelId), ChannelAccessError);
    assert.deepEqual((await service.readContext(owner, channelId)).messages.map(item => item.messageId), [message.messageId]);
    assert.deepEqual((await service.listMembers(owner, channelId)).map(member => member.participantId), ['human:owner', 'pet:executor']);
    await service.addMember(owner, channelId, guest);
    assert.equal((await service.readContext(guest, channelId)).messages.length, 1);
    // A human's label is the Studio client's current label.
    clients.set('guest', 'Guest');
    try {
      assert.deepEqual((await service.listMembers(owner, channelId)).map(member => member.label), ['owner', 'Executor', 'Guest']);
    } finally { clients.set('guest', 'guest'); }
    assert.deepEqual(events, ['channel.member.joined', 'channel.message.created', 'channel.member.left', 'channel.member.joined']);
  }));

  test(`${backend}: the last human member cannot be removed, and Studio authority manages any Channel`, () => withService(async (service) => {
    const { channelId } = (await service.createChannel(owner, { title: 'Release', pets: ['executor'] })).channel;
    await service.createChannel(guest, { title: 'Guest only', pets: [] });
    // The only human can neither be removed nor leave; a Pet can.
    await assert.rejects(service.removeMember(owner, channelId, owner), ChannelLastHumanError);
    await service.removeMember(owner, channelId, executor);
    await service.addMember(owner, channelId, guest);
    await service.removeMember(guest, channelId, owner);
    await assert.rejects(service.removeMember(guest, channelId, guest), ChannelLastHumanError);
    await assert.rejects(service.readContext(owner, channelId), ChannelAccessError);

    // Without membership only Studio authority may list, inspect and repair a Channel.
    const local: MemberRef = { kind: 'human', id: 'local' };
    await assert.rejects(service.addMember(local, channelId, owner), ChannelAccessError);
    await assert.rejects(service.listMembers(local, channelId), ChannelAccessError);
    assert.deepEqual((await service.listChannels(local, {}, { all: true })).channels, [], 'all needs Studio authority');
    assert.deepEqual((await service.listChannels(local, {}, { studio: true, all: true })).channels.map(item => item.title), ['Release', 'Guest only']);
    assert.deepEqual((await service.listMembers(local, channelId, { studio: true })).map(member => member.participantId), ['human:guest']);
    await service.addMember(local, channelId, owner, { studio: true });
    await service.removeMember(local, channelId, guest, { studio: true });
    await assert.rejects(service.removeMember(local, channelId, owner, { studio: true }), ChannelLastHumanError);
    assert.equal((await service.readContext(owner, channelId)).members.length, 1);
    await assert.rejects(service.readContext(local, channelId), ChannelAccessError, 'managing is not reading');
  }));

  test(`${backend}: messages keep their author as stored, resolve mentions against current members and reject cross-Channel or spoofed input`, () => withService(async (service) => {
    const a = (await service.createChannel(owner, { title: 'A', pets: ['executor'] })).channel.channelId;
    const b = (await service.createChannel(owner, { title: 'B', pets: ['executor'] })).channel.channelId;
    const { message } = await service.postMessage(owner, a, { body: 'Please [@Executor](participant:pet:executor) check.' });
    assert.deepEqual(message.author, owner);
    assert.deepEqual(message.mentions, [{ participantId: 'pet:executor', label: 'Executor' }]);
    const before = await service.readContext(owner, b);
    for (const input of [
      { body: 'reply', replyTo: message.messageId },
      { body: 'spoof', author: executor },
      { body: 'spoof', channelId: a },
      { body: '   ' },
      { body: 'old', mentions: [{ petId: 'executor' }] },
      { body: '[@Reviewer](participant:pet:reviewer) not a member' },
    ]) await assert.rejects(service.postMessage(owner, b, input), JSON.stringify(input));
    assert.deepEqual(await service.readContext(owner, b), before);
    for (const page of [{ limit: 0 }, { limit: 201 }, { after: -1 }, { after: 1.5 }]) {
      await assert.rejects(service.readContext(owner, a, page));
    }
  }));

  test(`${backend}: a Pet message is idempotent by its external id and keeps a reply whose mention cannot be resolved`, () => withService(async (service) => {
    const { channelId } = (await service.createChannel(owner, { title: 'A', pets: ['executor'] })).channel;
    const first = await service.postMessage(executor, channelId, { body: 'Done. [@Owner](participant:human:owner)' }, { externalRef: 'session-message-1' });
    assert.equal(first.created, true);
    assert.deepEqual(first.message.mentions, [{ participantId: 'human:owner', label: 'owner' }]);
    const again = await service.postMessage(executor, channelId, { body: 'Done again' }, { externalRef: 'session-message-1' });
    assert.equal(again.created, false);
    assert.deepEqual(again.message, first.message);
    // The same external id from another author is a different message.
    assert.equal((await service.postMessage(owner, channelId, { body: 'Mine' }, { externalRef: 'session-message-1' })).created, true);

    const lost = await service.postMessage(executor, channelId, { body: 'Over to [@Reviewer](participant:pet:reviewer).' }, { externalRef: 'session-message-2' });
    assert.equal(lost.created, true);
    assert.deepEqual(lost.message.mentions, []);
    assert.match(lost.mentionError ?? '', /pet:reviewer/);
    assert.equal((await service.readContext(owner, channelId)).messages.length, 3);
  }));

  test(`${backend}: a reader starts from the newest page, reads back with before and on with after`, () => withService(async (service) => {
    const a = (await service.createChannel(owner, { title: 'A', pets: [] })).channel.channelId;
    const b = (await service.createChannel(owner, { title: 'B', pets: [] })).channel.channelId;
    const empty = await service.readContext(owner, a);
    assert.deepEqual([empty.messages, empty.nextAfter, empty.hasMore, empty.hasEarlier], [[], 0, false, false]);
    const posted = [];
    for (let index = 0; index < 5; index += 1) {
      posted.push((await service.postMessage(owner, a, { body: `m${index}` })).message);
      // Another Channel's messages share the sequence and must not leak into this one's cursors.
      await service.postMessage(owner, b, { body: `other ${index}` });
    }
    const bodies = (page: { messages: Array<{ body: string }> }) => page.messages.map(message => message.body);
    const newest = await service.readContext(owner, a, { limit: 2 });
    assert.deepEqual(bodies(newest), ['m3', 'm4']);
    assert.deepEqual([newest.hasMore, newest.hasEarlier, newest.nextAfter, newest.nextBefore],
      [false, true, posted[4]!.sequence, posted[3]!.sequence]);
    const earlier = await service.readContext(owner, a, { before: newest.nextBefore, limit: 2 });
    assert.deepEqual([bodies(earlier), earlier.hasEarlier, earlier.hasMore], [['m1', 'm2'], true, true]);
    const oldest = await service.readContext(owner, a, { before: earlier.nextBefore, limit: 2 });
    assert.deepEqual([bodies(oldest), oldest.hasEarlier], [['m0'], false]);
    // A reader holding the newest page asks only for what came after it.
    const later = (await service.postMessage(owner, a, { body: 'm5' })).message;
    const next = await service.readContext(owner, a, { after: newest.nextAfter });
    assert.deepEqual([bodies(next), next.hasMore, next.hasEarlier, next.nextAfter], [['m5'], false, true, later.sequence]);
    const none = await service.readContext(owner, a, { after: next.nextAfter });
    assert.deepEqual([none.messages, none.nextAfter, none.hasMore], [[], later.sequence, false]);
    for (const page of [{ after: 1, before: 9 }, { before: 0 }, { before: 1.5 }]) {
      await assert.rejects(service.readContext(owner, a, page), JSON.stringify(page));
    }
  }));

  test(`${backend}: commit precedes notification; a failed write rolls back and emits nothing; observer failures do not undo it`, async () => {
    let failNext = false;
    // Fails after the row is written, inside the transaction, so only a rollback can remove it.
    const failing = (store: ChannelStore): ChannelStore => Object.assign(Object.create(store) as ChannelStore, {
      transaction: <T>(work: (inner: ChannelStore) => Promise<T>) => store.transaction(inner => work(failing(inner))),
      appendMessage: async (row: Parameters<ChannelStore['appendMessage']>[0]) => {
        const saved = await store.appendMessage(row);
        if (failNext) throw new Error('disk simulation');
        return saved;
      },
    });
    await withService(async (service, store) => {
      const { channelId } = (await service.createChannel(owner, { title: 'A', pets: [] })).channel;
      const seen: Array<Promise<boolean>> = [];
      service.subscribe((event) => {
        if (event.type !== 'channel.message.created') return;
        seen.push(store.getMessage(channelId, event.payload.messageId).then(Boolean));
      });
      failNext = true;
      await assert.rejects(service.postMessage(owner, channelId, { body: 'fails' }), /disk simulation/);
      failNext = false;
      assert.deepEqual((await store.readMessages(channelId, { after: 0, limit: 10 })).items, []);
      assert.equal(seen.length, 0);

      const remove = service.subscribe(() => { throw new Error('notification failure'); });
      const { message } = await service.postMessage(owner, channelId, { body: 'committed' });
      remove();
      assert.deepEqual(await Promise.all(seen), [true]);
      assert.deepEqual(await service.getMessage(channelId, message.messageId), message);
    }, failing);
  });

  test(`${backend}: human labels come from Studio clients in the same database without blocking Channel transactions`, async () => {
    const storage = createStudioStorage(config());
    try {
      const clientDb = await storage.open<ClientDatabase>('studio', clientMigrations);
      const clients = new StudioClients(async () => new KyselyClientStore(clientDb));
      await clients.ensure({ clientId: 'owner', label: 'Owner' });
      await clients.create({ clientId: 'guest', label: 'Guest' });
      const store = new KyselyChannelStore(await storage.open<ChannelDatabase>('channel', channelMigrations(storage.dialect)));
      const service = new ChannelService({ store, pets, humans: async (id) => {
        const client = await clients.get(id);
        return client && { label: client.label, active: !client.revokedAt };
      } });
      const { channel, members } = await service.createChannel(owner, { title: 'A', pets: ['executor'] });
      assert.deepEqual(members.map(member => member.label), ['Owner', 'Executor']);
      assert.equal((await service.addMember(owner, channel.channelId, guest)).label, 'Guest');
      const { message } = await service.postMessage(owner, channel.channelId, { body: 'Hi [@g](participant:human:guest)' });
      assert.deepEqual(message.mentions, [{ participantId: 'human:guest', label: 'Guest' }]);
      await clients.revoke('guest');
      await service.removeMember(owner, channel.channelId, guest);
      await assert.rejects(service.addMember(owner, channel.channelId, guest), /Unknown Studio client/);
    } finally { await storage.close(); }
  });

  test(`${backend}: a session reservation is made once per (Channel, Pet), unique per Pet session, and normalizes Channel ids`, () => withService(async (service) => {
    const { channelId } = (await service.createChannel(owner, { title: 'A', pets: ['executor'] })).channel;
    const [binding, same] = await Promise.all([
      service.reserveSession(` \t${channelId}\n `, 'executor', () => 'executor:12345678'),
      service.reserveSession(channelId, 'executor', () => 'executor:87654321'),
    ]);
    assert.deepEqual(same, binding);
    assert.equal(binding.registered, false);
    assert.equal((await service.confirmSession(binding)).registered, true);
    assert.equal((await service.getSession(channelId, 'executor'))?.registered, true);
    assert.deepEqual(await service.listSessions(owner, channelId), [{ ...binding, registered: true }]);
    await assert.rejects(service.listSessions(guest, channelId), ChannelAccessError);
    await assert.rejects(service.confirmSession({ ...binding, sessionId: 'executor:other' }), /binding changed/);
    const other = (await service.createChannel(owner, { title: 'B', pets: ['executor'] })).channel.channelId;
    await assert.rejects(service.reserveSession(other, 'executor', () => binding.sessionId));
  }));
}

// PGlite above has one session, so it cannot show races between connections.
// With PINPAWO_TEST_POSTGRES_URL (a server where the user may create
// databases), this runs on a fresh database with a real connection pool.
const postgresUrl = process.env.PINPAWO_TEST_POSTGRES_URL;
test('postgres server: concurrent removals cannot remove every human', { skip: !postgresUrl && 'PINPAWO_TEST_POSTGRES_URL is not set' }, async () => {
  const { default: pg } = await import('pg');
  const database = `channel_test_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: postgresUrl });
  await admin.connect();
  await admin.query(`create database ${database}`);
  const url = new URL(postgresUrl!);
  url.pathname = '/' + database;
  const storage = createStudioStorage({ kind: 'postgres', pool: new pg.Pool({ connectionString: url.href, max: 4 }) });
  try {
    const store = new KyselyChannelStore(await storage.open<ChannelDatabase>('channel', channelMigrations(storage.dialect)));
    const service = new ChannelService({ store, pets, humans });
    const { channelId } = (await service.createChannel(owner, { title: 'Race', pets: ['executor'] })).channel;
    await service.addMember(owner, channelId, guest);
    // Hold each removal after it reads the members until the other has read
    // them too (or is blocked from reading), so both decide on the same count.
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => { release = resolve; });
    const racing: ChannelStore = Object.create(store, {
      transaction: { value: <T>(work: (inner: ChannelStore) => Promise<T>) => store.transaction(inner => work(Object.create(inner, {
        listMembers: { value: async (id: string) => {
          const rows = await inner.listMembers(id);
          if (++arrived === 2) release();
          await Promise.race([bothRead, new Promise(resolve => setTimeout(resolve, 500))]);
          return rows;
        } },
      }))) },
    });
    const racer = new ChannelService({ store: racing, pets, humans });
    const results = await Promise.allSettled([
      racer.removeMember(owner, channelId, owner, { studio: true }),
      racer.removeMember(owner, channelId, guest, { studio: true }),
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
    assert.ok((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason instanceof ChannelLastHumanError);
    const left = (await store.listMembers(channelId)).filter(member => !member.leftAt);
    assert.equal(left.filter(member => member.kind === 'human').length, 1);
  } finally {
    await storage.close();
    await admin.query(`drop database if exists ${database}`);
    await admin.end();
  }
});
