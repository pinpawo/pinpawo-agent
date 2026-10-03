import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ChannelService } from './channelService';

const human = { kind: 'human', id: 'owner' } as const;
const pet = { kind: 'pet', id: 'executor' } as const;
const goal = { title: 'CRM', goal: 'Improve CRM', scope: 'Single record update only' };

test('durable revisions and versioned deliveries preserve two rounds and paginate in order', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'channel-history-'));
  const file = path.join(root, 'channels.sqlite');
  let service = new ChannelService(file);
  try {
    service.init();
    const channel = service.createChannel(goal, human);
    const first = service.sendMessage(channel.channelId, {
      body: 'Partial implementation @reviewer is quoted text',
      artifacts: [{ uri: 'https://example.com/pr/1', version: 'commit-a' }],
    }, pet);
    const feedback = service.sendMessage(channel.channelId, {
      body: 'Fix retry behavior', replyTo: first.messageId, mentions: [{ petId: 'executor' }, { petId: 'investigator' }],
    }, { kind: 'pet', id: 'reviewer' });
    const revised = service.reviseChannel(channel.channelId, {
      ...goal, scope: 'Fix retry only; do not add bulk updates', expectedRevision: channel.sequence,
      reason: 'User narrows current round', sourceMessageId: feedback.messageId,
    }, human);
    const second = service.sendMessage(channel.channelId, {
      body: 'Retry fixed, other work remains', replyTo: feedback.messageId,
      artifacts: [{ uri: 'https://example.com/pr/1', version: 'commit-b' }],
    }, pet);
    assert.equal(first.revision, channel.sequence);
    assert.equal(second.revision, revised.sequence);
    assert.deepEqual(first.mentions, []);
    service.close();
    service = new ChannelService(file); service.init();
    const current = service.readContext(channel.channelId, { limit: 2 });
    assert.equal(current.channel.scope, revised.scope);
    assert.deepEqual(current.history.entries, [channel, first]);
    assert.equal(current.history.hasMore, true);
    const next = service.readHistory(channel.channelId, { after: current.history.nextAfter });
    assert.deepEqual(next.entries, [feedback, revised, second]);
    assert.equal(next.hasMore, false);
    assert.deepEqual(service.getMessage(channel.channelId, first.messageId).artifacts, first.artifacts);
    assert.equal(service.listChannels().channels.length, 1);
  } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('rejects cross-Channel references, spoofed fields, stale revisions and malformed pagination without writes', () => {
  const service = new ChannelService(); service.init();
  try {
    const a = service.createChannel(goal, human);
    const b = service.createChannel(goal, human);
    const message = service.sendMessage(a.channelId, { body: 'delivery' }, pet);
    const before = service.readHistory(b.channelId);
    for (const input of [
      { body: 'reply', replyTo: message.messageId },
      { body: 'spoof', author: human },
      { body: 'spoof', channelId: a.channelId },
      { body: '   ' },
      { body: 'duplicate', mentions: [{ petId: 'executor' }, { petId: ' executor ' }] },
    ]) assert.throws(() => service.sendMessage(b.channelId, input, pet));
    assert.throws(() => service.reviseChannel(b.channelId, {
      ...goal, expectedRevision: b.sequence, reason: 'wrong source', sourceMessageId: message.messageId,
    }, human), /reference/);
    service.reviseChannel(a.channelId, { ...goal, expectedRevision: a.sequence, reason: 'changed' }, human);
    assert.throws(() => service.reviseChannel(a.channelId, { ...goal, expectedRevision: a.sequence, reason: 'stale' }, human), /conflict/);
    assert.deepEqual(service.readHistory(b.channelId), before);
    for (const page of [{ limit: 0 }, { limit: 201 }, { after: -1 }, { after: 1.5 }]) {
      assert.throws(() => service.readHistory(a.channelId, page));
    }
    assert.throws(() => service.sendMessage('missing', { body: 'no' }, pet), /Unknown/);
  } finally { service.close(); }
});

test('commit precedes notification; failed storage emits nothing; observer failures do not undo persisted messages', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'channel-commit-'));
  const file = path.join(root, 'channel.sqlite');
  const service = new ChannelService(file); service.init();
  const observer = new DatabaseSync(file);
  try {
    const channel = service.createChannel(goal, human);
    let events = 0;
    const persistedWhenNotified: boolean[] = [];
    service.subscribe((entry) => {
      events++;
      persistedWhenNotified.push(Boolean(observer.prepare('SELECT sequence FROM channel_entries WHERE sequence=?').get(entry.sequence)));
    });
    observer.exec("CREATE TRIGGER fail_message BEFORE INSERT ON channel_entries WHEN NEW.kind='message' BEGIN SELECT RAISE(ABORT, 'disk simulation'); END");
    assert.throws(() => service.sendMessage(channel.channelId, { body: 'fails' }, pet), /disk simulation/);
    assert.equal(events, 0);
    assert.equal(service.readHistory(channel.channelId).entries.length, 1);
    observer.exec('DROP TRIGGER fail_message');
    const remove = service.subscribe(() => { throw new Error('notification failure'); });
    const message = service.sendMessage(channel.channelId, { body: 'committed' }, pet);
    remove();
    assert.equal(events, 1);
    assert.deepEqual(persistedWhenNotified, [true]);
    assert.deepEqual(service.getMessage(channel.channelId, message.messageId), message);
  } finally { observer.close(); service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('two connections reject stale goal updates and channel listing has a stable cursor', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'channel-concurrent-'));
  const file = path.join(root, 'channel.sqlite');
  const one = new ChannelService(file); const two = new ChannelService(file);
  try {
    one.init(); two.init();
    const a = one.createChannel(goal, human);
    const b = two.createChannel(goal, human);
    const page = one.listChannels({ limit: 1 });
    two.reviseChannel(a.channelId, { ...goal, expectedRevision: a.sequence, reason: 'updated' }, human);
    assert.throws(() => one.reviseChannel(a.channelId, { ...goal, expectedRevision: a.sequence, reason: 'stale' }, human), /conflict/);
    assert.deepEqual(one.listChannels({ after: page.nextAfter }).channels.map((c) => c.channelId), [b.channelId]);
    assert.equal(one.readHistory(a.channelId).entries.length, 2);
  } finally { one.close(); two.close(); rmSync(root, { recursive: true, force: true }); }
});

test('pair reservation and output identity are shared across SQLite connections and preserve existing history', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'channel-binding-'));
  const file = path.join(root, 'channel.sqlite');
  const one = new ChannelService(file); const two = new ChannelService(file);
  try {
    one.init();
    const channel = one.createChannel(goal, human);
    const old = one.sendMessage(channel.channelId, { body: 'existing history' }, human);
    one.close();
    const previous = new DatabaseSync(file);
    previous.exec('DROP TABLE channel_sessions; DROP TABLE channel_outputs; DROP TABLE channel_interrupt_notifications; PRAGMA user_version=1;');
    previous.close();
    one.init(); two.init();
    const binding = one.reserveBinding(channel.channelId, 'executor', () => 'executor:12345678');
    assert.deepEqual(two.reserveBinding(channel.channelId, 'executor', () => { throw Error('must reuse'); }), binding);
    two.confirmBinding(binding);
    assert.equal(one.getBinding(channel.channelId, 'executor')!.registered, true);
    const other = one.createChannel(goal, human);
    assert.throws(() => two.reserveBinding(other.channelId, 'executor', () => binding.sessionId), /UNIQUE/);
    const source = { petId: 'executor', sessionId: binding.sessionId, invocationId: 'turn' };
    const output = one.recordOutput(channel.channelId, source, 'Which destination?')!;
    assert.deepEqual(two.recordOutput(channel.channelId, source, 'Which destination?'), output);
    assert.throws(() => one.sendMessage(other.channelId, { body: 'wrong scope' }, pet, source), /binding/);
    assert.deepEqual(one.getMessage(channel.channelId, old.messageId), old);
  } finally { one.close(); two.close(); rmSync(root, { recursive: true, force: true }); }
});

test('whitespace Channel aliases share one binding and keep output history and replyTo visible', () => {
  const service = new ChannelService(); service.init();
  try {
    const channel = service.createChannel(goal, human);
    const alias = ` \t${channel.channelId}\n `;
    const binding = service.reserveBinding(alias, pet.id, () => 'executor:12345678');
    assert.equal(binding.channelId, channel.channelId);
    assert.deepEqual(service.reserveBinding(channel.channelId, pet.id, () => { throw Error('duplicate allocation'); }), binding);
    assert.deepEqual(service.getBinding(alias, pet.id), binding);
    assert.deepEqual(service.listBindings(alias), [binding]);
    service.confirmBinding({ ...binding, channelId: alias });
    const output = service.recordOutput(alias, { petId: pet.id, sessionId: binding.sessionId, invocationId: 'question' }, 'Which destination?')!;
    assert.equal(output.channelId, channel.channelId);
    assert.equal(service.readHistory(channel.channelId).entries.at(-1)?.sequence, output.sequence);
    assert.deepEqual(service.getMessage(alias, output.messageId), output);
    const reply = service.sendMessage(alias, { body: 'staging', replyTo: output.messageId }, human);
    assert.deepEqual(service.getMessage(channel.channelId, reply.messageId), reply);
    assert.equal(service.readContext(alias).sessions.length, 1);
  } finally { service.close(); }
});

test('interrupt notifications reuse the public projection, persist and deduplicate without entering model context', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'channel-interrupt-'));
  const file = path.join(root, 'channels.sqlite');
  let service = new ChannelService(file); service.init();
  try {
    const channelId = service.createChannel(goal, human).channelId;
    const other = service.createChannel(goal, human).channelId;
    const binding = service.reserveBinding(channelId, pet.id, () => 'executor:12345678');
    const oldMessage = service.sendMessage(channelId, { body: 'existing v2 message' }, human);
    service.close();
    const previous = new DatabaseSync(file);
    previous.exec('DROP TABLE channel_interrupt_notifications; PRAGMA user_version=2;');
    previous.close();
    service.init();
    assert.deepEqual(service.getMessage(channelId, oldMessage.messageId), oldMessage);
    const source = { petId: pet.id, sessionId: binding.sessionId, invocationId: 'review-turn' };
    const pending = { interruptId: 'review-id', payload: { kind: 'human_review', interactions: [{
      interactionId: 'review', schemaVersion: 2,
      view: { kind: 'diff', title: 'Review change', patch: 'private-review-patch', summary: 'Change' },
      options: [{ id: 'approve', label: 'Approve', batchSubmission: 'defer' }],
    }] } };
    const saved = service.recordInterrupt(channelId, source, pending);
    assert.deepEqual(service.recordInterrupt(channelId, source, pending), saved);
    assert.throws(() => service.recordInterrupt(other, source, pending), /binding/);
    assert.throws(() => service.recordOutput(other, source, 'misdirected'), /binding/);
    const unsafe = structuredClone(pending) as any;
    unsafe.payload.interactions[0].options[0].effects = [{ type: 'graph.authorize_tool_action', scope: 'thread' }];
    assert.throws(() => service.recordInterrupt(channelId, source, unsafe), /Invalid/);
    service.recordInterrupt(channelId, { ...source, invocationId: 'paused' }, { interruptId: 'pause-id', payload: { kind: 'pause_task' } });
    service.close(); service = new ChannelService(file); service.init();
    const page = service.readInterruptNotifications(channelId, { limit: 1 });
    assert.deepEqual(page.notifications, [saved]); assert.equal(page.hasMore, true);
    assert.equal(service.readInterruptNotifications(channelId, { after: page.nextAfter }).notifications[0]?.pendingInterrupt.payload.kind, 'pause_task');
    assert.ok(!JSON.stringify(service.readContext(channelId)).includes('private-review-patch'));
    assert.equal(service.readHistory(channelId).entries.length, 2);
  } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
});
