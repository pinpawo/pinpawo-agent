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

test('execution observations survive restart, preserve failures, reconcile early lifecycle and isolate Channels', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'channel-executions-'));
  const file = path.join(root, 'channels.sqlite');
  let service = new ChannelService(file);
  try {
    service.init();
    const a = service.createChannel(goal, human).channelId;
    const b = service.createChannel(goal, human).channelId;
    const binding = service.reserveBinding(a, 'executor', () => 'executor:12345678');
    const first = service.sendMessage(a, { body: 'start' }, human);
    service.beginExecution(a, binding, first.messageId);
    const source = { petId: 'executor', sessionId: binding.sessionId, invocationId: 'first' };
    service.recordExecution(a, source, 'running', '2026-10-04T00:00:00Z');
    service.recordExecution(a, source, 'failed', '2026-10-04T00:00:01Z', 'Provider denied request (403).');
    const accepted = service.acceptExecution(first.messageId, 'first');
    assert.equal(accepted.state, 'failed', 'late receipt cannot regress a real failure');
    assert.equal(service.readExecutions(a).executions.length, 1, 'early observation and request reconcile into one row');
    assert.equal(accepted.messageId, first.messageId);
    service.recordExecution(a, source, 'queued', '2026-10-04T00:00:02Z');
    assert.equal(service.readExecutions(a).executions[0]?.state, 'failed');
    const next = service.sendMessage(a, { body: 'continue' }, human);
    service.beginExecution(a, binding, next.messageId);
    service.acceptExecution(next.messageId, 'second');
    service.recordExecution(a, { ...source, invocationId: 'second' }, 'running', '2026-10-04T00:00:03Z');
    assert.throws(() => service.recordExecution(b, source, 'completed', 'now'), /binding/);
    const otherBinding = service.reserveBinding(b, 'executor', () => 'executor:87654321');
    assert.throws(() => service.recordExecution(b, { ...source, sessionId: otherBinding.sessionId }, 'completed', 'now'), /identity/);
    assert.deepEqual(service.readExecutions(b).executions, []);
    const page = service.readExecutions(a, { limit: 1 });
    assert.equal(page.hasMore, true);
    assert.equal(service.readExecutions(a, { after: page.nextAfter }).executions.length, 1);
    service.close(); service = new ChannelService(file); service.init();
    const restored = service.readExecutions(a).executions;
    assert.equal(restored[0]?.state, 'failed');
    assert.equal(restored[0]?.error, 'Provider denied request (403).');
    assert.equal(restored[0]?.observationLost, false);
    assert.equal(restored[1]?.state, 'running');
    assert.equal(restored[1]?.observationLost, true, 'restart cannot claim the old invocation is still executing');
    assert.ok(!JSON.stringify(service.readContext(a)).includes('Provider denied'));
  } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('admission failure and output storage failure remain visible without creating a replay queue', () => {
  const service = new ChannelService(); service.init();
  try {
    const id = service.createChannel(goal, human).channelId;
    const binding = service.reserveBinding(id, 'executor', () => 'executor:12345678');
    const message = service.sendMessage(id, { body: 'work' }, human);
    service.beginExecution(id, binding, message.messageId);
    service.failExecution(message.messageId, 'Host unavailable.');
    const failed = service.readExecutions(id).executions[0]!;
    assert.equal(failed.state, 'failed'); assert.equal(failed.invocationId, undefined);
    const source = { petId: 'executor', sessionId: binding.sessionId, invocationId: 'done' };
    service.recordExecution(id, source, 'completed', '2026-10-04T00:00:00Z');
    service.recordDeliveryFailure('done', 'disk unavailable');
    const done = service.readExecutions(id).executions[1]!;
    assert.equal(done.state, 'completed'); assert.equal(done.deliveryError, 'disk unavailable');
  } finally { service.close(); }
});

test('schema v3 upgrade preserves Channel history and session bindings while adding empty observation history', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'channel-v4-upgrade-'));
  const file = path.join(root, 'channels.sqlite');
  let service = new ChannelService(file); service.init();
  try {
    const id = service.createChannel(goal, human).channelId;
    const message = service.sendMessage(id, { body: 'Existing delivery history.' }, human);
    const binding = service.reserveBinding(id, 'executor', () => 'executor:12345678');
    service.confirmBinding(binding);
    service.close();
    const previous = new DatabaseSync(file);
    previous.exec('DROP TABLE channel_executions; PRAGMA user_version=3;'); previous.close();
    service = new ChannelService(file); service.init();
    assert.equal(service.getMessage(id, message.messageId).body, message.body);
    assert.equal(service.getBinding(id, 'executor')?.sessionId, binding.sessionId);
    assert.equal(service.getBinding(id, 'executor')?.registered, true);
    assert.deepEqual(service.readExecutions(id).executions, []);
  } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
});

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
    ]) assert.throws(() => service.sendMessage(b.channelId, input, pet));
    assert.throws(() => service.reviseChannel(b.channelId, {
      ...goal, expectedRevision: b.sequence, reason: 'wrong source', sourceMessageId: message.messageId,
    }, human), /reference/);
    service.reviseChannel(a.channelId, { ...goal, expectedRevision: a.sequence, reason: 'changed' }, human);
    assert.throws(() => service.reviseChannel(a.channelId, { ...goal, expectedRevision: a.sequence, reason: 'stale' }, human), /conflict/);
    assert.deepEqual(service.readHistory(b.channelId), before);
    const addressed = service.sendMessage(b.channelId, { body: 'one target', mentions: [{ petId: 'executor' }, { petId: ' executor ' }] }, pet);
    assert.deepEqual(addressed.mentions, [{ petId: 'executor' }], 'repeating an identity expresses one target');
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
    assert.throws(() => service.recordInterrupt(channelId, source, { interruptId: 'old-pause', payload: { kind: 'pause_task' } } as any), /Invalid/);
    service.recordInterrupt(channelId, { ...source, invocationId: 'second-review' }, { ...pending, interruptId: 'second-review-id' });
    service.close(); service = new ChannelService(file); service.init();
    const page = service.readInterruptNotifications(channelId, { limit: 1 });
    assert.deepEqual(page.notifications, [saved]); assert.equal(page.hasMore, true);
    assert.equal(service.readInterruptNotifications(channelId, { after: page.nextAfter }).notifications[0]?.pendingInterrupt.payload.kind, 'human_review');
    assert.ok(!JSON.stringify(service.readContext(channelId)).includes('private-review-patch'));
    assert.equal(service.readHistory(channelId).entries.length, 2);
  } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('legacy pause notification data is preserved and explicitly refused rather than projected as a review', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'channel-old-notice-'));
  const file = path.join(root, 'channels.sqlite');
  const service = new ChannelService(file);
  let database: DatabaseSync | undefined;
  try {
    service.init();
    const id = service.createChannel(goal, human).channelId;
    const original = JSON.stringify({ channelId: id, source: { petId: 'one', sessionId: 'one:12345678', invocationId: 'old' },
      occurredAt: '2026-10-01T00:00:00.000Z', pendingInterrupt: { interruptId: 'old', payload: { kind: 'pause_task' } } });
    database = new DatabaseSync(file);
    database.prepare('INSERT INTO channel_interrupt_notifications (channel_id, pet_id, session_id, invocation_id, interrupt_id, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'one', 'one:12345678', 'old', 'old', original);
    assert.throws(() => service.readInterruptNotifications(id), /Unsupported.*preserved/);
    assert.equal((database.prepare('SELECT data FROM channel_interrupt_notifications').get() as { data: string }).data, original);
    assert.equal(service.readContext(id).history.entries.length, 1);
  } finally { database?.close(); service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a Pet tool-call message keeps its calls as written, settles in place and addresses nobody', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'channel-tool-calls-'));
  const file = path.join(root, 'channels.sqlite');
  let service = new ChannelService(file); service.init();
  try {
    const channelId = service.createChannel(goal, human).channelId;
    const binding = service.reserveBinding(channelId, pet.id, () => 'executor:12345678');
    const source = { petId: pet.id, sessionId: binding.sessionId, invocationId: 'turn' };
    const calls = [{ id: 'c1', name: 'delegate_capability', args: { briefing: 'Inspect A.' } },
      { id: 'c2', name: 'lookup', args: { q: 'x' } }];
    const message = service.recordToolCallMessage(channelId, source, { messageId: 'm1', text: '', toolCalls: calls });
    assert.equal(message.body, '');
    assert.deepEqual(message.mentions, []);
    assert.deepEqual(message.toolCalls, calls.map(call => ({ ...call, status: 'running' })));
    // Replays of the same session message record nothing new.
    assert.deepEqual(service.recordToolCallMessage(channelId, source, { messageId: 'm1', text: '', toolCalls: calls }), message);
    service.settleToolCall(channelId, source, { messageId: 'm1', callId: 'c1', status: 'completed' });
    service.settleToolCall(channelId, source, { messageId: 'unseen', callId: 'c9', status: 'failed' });
    service.interruptToolCalls(source);
    service.close(); service = new ChannelService(file); service.init();
    assert.deepEqual(service.getMessage(channelId, message.messageId).toolCalls?.map(call => call.status), ['completed', 'interrupted']);
    assert.equal(service.readHistory(channelId).entries.length, 2);
    assert.throws(() => service.recordToolCallMessage(channelId, { ...source, sessionId: 'other' }, { messageId: 'm2', text: '', toolCalls: calls }), /binding/);
    assert.throws(() => service.recordToolCallMessage(channelId, source, { messageId: 'm3', text: '', toolCalls: [] }));
  } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
});
