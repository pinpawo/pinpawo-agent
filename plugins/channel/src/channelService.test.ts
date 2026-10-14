import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ChannelAccessError, ChannelNotFoundError, ChannelService } from './channelService';
import type { MemberRef } from './channelStore';
import { SqliteChannelStore } from './sqliteChannelStore';

const owner: MemberRef = { kind: 'human', id: 'owner' };
const guest: MemberRef = { kind: 'human', id: 'guest' };
const executor: MemberRef = { kind: 'pet', id: 'executor' };
const pets = () => [{ petId: 'executor', name: 'Executor' }, { petId: 'reviewer', name: 'Reviewer' }];

function open(file = ':memory:') {
  const store = new SqliteChannelStore(file);
  store.init();
  return { store, service: new ChannelService({ store, pets }) };
}

test('a Channel starts with its creator and the Pets it names, and lists only for its members', () => {
  const { store, service } = open();
  try {
    const { channel, members } = service.createChannel(owner, { title: 'Release', description: 'Ship 1.0', pets: ['executor', 'executor'] });
    assert.equal(channel.title, 'Release');
    assert.deepEqual(channel.createdBy, owner);
    assert.deepEqual(members.map(member => [member.participantId, member.label]), [['human:owner', 'owner'], ['pet:executor', 'Executor']]);
    assert.throws(() => service.createChannel(owner, { title: 'No pets field' }));
    assert.throws(() => service.createChannel(owner, { title: 'Unknown', pets: ['ghost'] }), /Unknown Pet/);
    assert.throws(() => service.createChannel(owner, { title: 'Old shape', goal: 'g', scope: 's', pets: [] }));
    const second = service.createChannel(owner, { title: 'Second', pets: [] }).channel;
    service.createChannel(guest, { title: 'Guest only', pets: [] });

    const first = service.listChannels(owner, { limit: 1 });
    assert.deepEqual(first.channels.map(item => item.channelId), [channel.channelId]);
    assert.equal(first.hasMore, true);
    assert.deepEqual(service.listChannels(owner, { after: first.nextAfter }).channels.map(item => item.channelId), [second.channelId]);
    assert.deepEqual(service.listChannels(executor).channels.map(item => item.channelId), [channel.channelId]);

    const updated = service.updateChannel(owner, channel.channelId, { description: null });
    assert.equal(updated.description, undefined);
    assert.equal(updated.title, 'Release');
  } finally { store.close(); }
});

test('only current members read, speak and manage members; leaving keeps history and rejoining restores access', () => {
  const { store, service } = open();
  try {
    const { channel } = service.createChannel(owner, { title: 'Release', pets: ['executor'] });
    const { channelId } = channel;
    assert.throws(() => service.readContext(guest, channelId), ChannelAccessError);
    assert.throws(() => service.postMessage(guest, channelId, { body: 'hi' }), ChannelAccessError);
    assert.throws(() => service.addMember(guest, channelId, guest), ChannelAccessError);
    assert.throws(() => service.readContext(owner, 'missing'), ChannelNotFoundError);
    assert.throws(() => service.addMember(owner, channelId, { kind: 'pet', id: 'ghost' }), /Unknown Pet/);

    const events: string[] = [];
    service.subscribe(event => events.push(event.type));
    assert.equal(service.addMember(owner, channelId, guest).participantId, 'human:guest');
    service.addMember(owner, channelId, guest);
    const { message } = service.postMessage(guest, channelId, { body: 'Joined.' });
    service.removeMember(owner, channelId, guest);
    service.removeMember(owner, channelId, guest);
    assert.throws(() => service.readContext(guest, channelId), ChannelAccessError);
    assert.deepEqual(service.readContext(owner, channelId).messages.map(item => item.messageId), [message.messageId]);
    assert.deepEqual(service.listMembers(owner, channelId).map(member => member.participantId), ['human:owner', 'pet:executor']);
    service.addMember(owner, channelId, guest);
    assert.equal(service.readContext(guest, channelId).messages.length, 1);
    assert.deepEqual(events, ['channel.member.joined', 'channel.message.created', 'channel.member.left', 'channel.member.joined']);
  } finally { store.close(); }
});

test('messages keep their author as stored, resolve mentions against current members and reject cross-Channel or spoofed input', () => {
  const { store, service } = open();
  try {
    const a = service.createChannel(owner, { title: 'A', pets: ['executor'] }).channel.channelId;
    const b = service.createChannel(owner, { title: 'B', pets: ['executor'] }).channel.channelId;
    const { message } = service.postMessage(owner, a, { body: 'Please [@Executor](participant:pet:executor) check.' });
    assert.deepEqual(message.author, owner);
    assert.deepEqual(message.mentions, [{ participantId: 'pet:executor', label: 'Executor' }]);
    const before = service.readContext(owner, b);
    for (const input of [
      { body: 'reply', replyTo: message.messageId },
      { body: 'spoof', author: executor },
      { body: 'spoof', channelId: a },
      { body: '   ' },
      { body: 'old', mentions: [{ petId: 'executor' }] },
      { body: '[@Reviewer](participant:pet:reviewer) not a member' },
    ]) assert.throws(() => service.postMessage(owner, b, input), JSON.stringify(input));
    assert.deepEqual(service.readContext(owner, b), before);
    for (const page of [{ limit: 0 }, { limit: 201 }, { after: -1 }, { after: 1.5 }]) {
      assert.throws(() => service.readContext(owner, a, page));
    }
  } finally { store.close(); }
});

test('a Pet message is idempotent by its external id and keeps a reply whose mention cannot be resolved', () => {
  const { store, service } = open();
  try {
    const { channelId } = service.createChannel(owner, { title: 'A', pets: ['executor'] }).channel;
    const first = service.postMessage(executor, channelId, { body: 'Done. [@Owner](participant:human:owner)' }, { externalRef: 'session-message-1' });
    assert.equal(first.created, true);
    assert.deepEqual(first.message.mentions, [{ participantId: 'human:owner', label: 'owner' }]);
    const again = service.postMessage(executor, channelId, { body: 'Done again' }, { externalRef: 'session-message-1' });
    assert.equal(again.created, false);
    assert.deepEqual(again.message, first.message);
    // The same external id from another author is a different message.
    assert.equal(service.postMessage(owner, channelId, { body: 'Mine' }, { externalRef: 'session-message-1' }).created, true);

    const lost = service.postMessage(executor, channelId, { body: 'Over to [@Reviewer](participant:pet:reviewer).' }, { externalRef: 'session-message-2' });
    assert.equal(lost.created, true);
    assert.deepEqual(lost.message.mentions, []);
    assert.match(lost.mentionError ?? '', /pet:reviewer/);
    assert.equal(service.readContext(owner, channelId).messages.length, 3);
  } finally { store.close(); }
});

test('commit precedes notification; failed storage emits nothing; observer failures do not undo persisted messages', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'channel-commit-'));
  const file = path.join(root, 'channel.sqlite');
  const { store, service } = open(file);
  const observer = new DatabaseSync(file);
  try {
    const { channelId } = service.createChannel(owner, { title: 'A', pets: [] }).channel;
    let events = 0;
    const persistedWhenNotified: boolean[] = [];
    service.subscribe((event) => {
      if (event.type !== 'channel.message.created') return;
      events++;
      persistedWhenNotified.push(Boolean(observer.prepare('SELECT sequence FROM channel_messages WHERE sequence=?').get(event.payload.sequence)));
    });
    observer.exec("CREATE TRIGGER fail_message BEFORE INSERT ON channel_messages BEGIN SELECT RAISE(ABORT, 'disk simulation'); END");
    assert.throws(() => service.postMessage(owner, channelId, { body: 'fails' }), /disk simulation/);
    assert.equal(events, 0);
    observer.exec('DROP TRIGGER fail_message');
    const remove = service.subscribe(() => { throw new Error('notification failure'); });
    const { message } = service.postMessage(owner, channelId, { body: 'committed' });
    remove();
    assert.equal(events, 1);
    assert.deepEqual(persistedWhenNotified, [true]);
    assert.deepEqual(service.getMessage(channelId, message.messageId), message);
  } finally { observer.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('session reservation is shared across SQLite connections, unique per Pet session, and normalizes Channel ids', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'channel-binding-'));
  const file = path.join(root, 'channel.sqlite');
  const one = open(file); const two = open(file);
  try {
    const { channelId } = one.service.createChannel(owner, { title: 'A', pets: ['executor'] }).channel;
    const binding = one.service.reserveSession(` \t${channelId}\n `, 'executor', () => 'executor:12345678');
    assert.deepEqual(binding, { channelId, petId: 'executor', sessionId: 'executor:12345678', registered: false });
    assert.deepEqual(two.service.reserveSession(channelId, 'executor', () => { throw Error('must reuse'); }), binding);
    assert.equal(two.service.confirmSession(binding).registered, true);
    assert.equal(one.service.getSession(channelId, 'executor')?.registered, true);
    assert.deepEqual(one.service.listSessions(owner, channelId), [{ ...binding, registered: true }]);
    assert.throws(() => one.service.listSessions(guest, channelId), ChannelAccessError);
    const other = one.service.createChannel(owner, { title: 'B', pets: ['executor'] }).channel.channelId;
    assert.throws(() => two.service.reserveSession(other, 'executor', () => binding.sessionId), /UNIQUE/);
  } finally { one.store.close(); two.store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('the store refuses a database written by the earlier Channel model', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'channel-old-'));
  const file = path.join(root, 'channels.sqlite');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE channel_entries (sequence INTEGER PRIMARY KEY); PRAGMA user_version=5;');
  old.close();
  try {
    assert.throws(() => new SqliteChannelStore(file).init(), /Unsupported Channel schema version 5/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
