import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudioStorage, type StudioStorageConfig } from '@pinpawo/studio';
import { createPglitePool } from '../../../tests/support/pglitePool';
import { ChannelAccessError, ChannelNotFoundError, ChannelService } from './channelService';
import type { ChannelStore, MemberRef } from './store/channelStore';
import { KyselyChannelStore, channelMigrations, type ChannelDatabase } from './store/kysely';

const owner: MemberRef = { kind: 'human', id: 'owner' };
const guest: MemberRef = { kind: 'human', id: 'guest' };
const executor: MemberRef = { kind: 'pet', id: 'executor' };
const pets = () => [{ petId: 'executor', name: 'Executor' }, { petId: 'reviewer', name: 'Reviewer' }];

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
      await run(new ChannelService({ store: wrap(store), pets }), store);
    } finally { await storage.close(); }
  }

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
    assert.deepEqual(events, ['channel.member.joined', 'channel.message.created', 'channel.member.left', 'channel.member.joined']);
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
