import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readChannelPages, executionLabel, channelPetIdentity, channelMessageIdentity, channelMessageExecution,
  channelExecutionOutputs, channelMessagesGroup, channelQuote, channelMessageInput, channelMessageExecutions, type ChannelExecution, type ChannelMessage } from '../src/channelData';
import { ChannelTimeline, ChannelExecutionHistory } from '../src/ChannelPanel';
import { ChannelDispatchQueues } from '../src/ChannelDispatchQueues';

const message: ChannelMessage = { kind: 'message', channelId: 'a', sequence: 2, messageId: 'm', body: 'Full public delivery.\n\nMissing work remains.\n\n```ts\nconst evidence = 42;\n```',
  author: { kind: 'pet', id: 'worker' }, occurredAt: '2026-10-04T00:00:00Z', revision: 1,
  source: { petId: 'worker', sessionId: 'worker:same', invocationId: 'i' }, artifacts: [{ uri: 'javascript:alert(1)', label: 'unsafe' }], mentions: [] };
const execution: ChannelExecution = { sequence: 1, executionId: 'e', channelId: 'a', petId: 'worker', sessionId: 'worker:same',
  state: 'running', occurredAt: '2026-10-04T00:00:00Z', observationLost: false };

test('history loading follows every cursor to include recent deliveries and fails on a nonadvancing page', async () => {
  const paths: string[] = [];
  const values = await readChannelPages<string>(async path => {
    paths.push(path);
    return paths.length === 1 ? { entries: ['old'], nextAfter: 200, hasMore: true } : { entries: ['recent'], nextAfter: 201, hasMore: false };
  }, '/channels/context?channelId=a', 'entries');
  assert.deepEqual(values, ['old', 'recent']);
  assert.ok(paths[1]?.includes('&after=200'));
  await assert.rejects(readChannelPages(async () => ({ entries: [], nextAfter: 0, hasMore: true }), '/history', 'entries'), /advance/);
});

test('timeline renders full handoff body and safe references; all participant messages offer reply', () => {
  const markup = renderToStaticMarkup(<ChannelTimeline entries={[message, { ...message, messageId: 'note', source: undefined, body: '<script>bad()</script>' }]} pending={false} onReply={() => undefined} />);
  assert.ok(markup.includes('Missing work remains.')); assert.ok(markup.includes('evidence = 42'));
  assert.equal((markup.match(/>Reply to /g) ?? []).length, 2);
  assert.ok(!markup.includes('href="javascript:')); assert.ok(!markup.includes('<script>'));
});

test('unified messages separate reply context from recipients and display target identities and failures in the timeline', () => {
  assert.deepEqual(channelMessageInput('a', 'pet:other', ' answer ', message), {
    channelId: 'a', body: 'answer', mentions: [{ participantId: 'pet:other' }], replyTo: 'm',
  });
  assert.deepEqual(channelMessageInput('a', '', 'note', { ...message, source: undefined }), { channelId: 'a', body: 'note', replyTo: 'm' });
  assert.throws(() => channelMessageInput('b', '', 'reply', message), /outside/);
  assert.throws(() => channelMessageInput('a', 'pet:worker', '   '), /message/);
  const human = { ...message, source: undefined, author: { kind: 'human', id: 'owner' }, mentions: [{ participantId: 'pet:other', label: 'Old label' }] };
  const runs = [
    { ...execution, messageId: 'm', executionId: 'one', state: 'failed' as const, error: 'Admission denied.' },
    { ...execution, messageId: 'm', executionId: 'two', petId: 'other', state: 'queued' as const },
  ];
  assert.equal(channelMessageExecutions(human, runs).length, 2);
  const markup = renderToStaticMarkup(<ChannelTimeline entries={[human]} executions={runs} pending={false} onReply={() => undefined}
    participants={[{ participantId: 'pet:other', kind: 'pet', id: 'other', label: 'New label' }]} viewerParticipantId="human:owner" />);
  assert.ok(markup.includes('Me')); assert.ok(markup.includes('@New label'));
  assert.ok(markup.includes('Admission denied.')); assert.ok(markup.includes('queued'));
  assert.ok(!markup.includes('retry'));
});

test('global queue rendering uses runtime entries from every Channel and hides private request context', () => {
  const markup = renderToStaticMarkup(<ChannelDispatchQueues connected={true} pets={[{ petId: 'worker', name: 'Worker' }]}
    channels={[{ kind: 'revision', channelId: 'b', sequence: 1, title: 'Other Channel', goal: 'goal', scope: 'scope', reason: 'created', occurredAt: 'now', author: { kind: 'human', id: 'owner' }, references: [] }]}
    queues={[{ petId: 'worker', state: 'busy', activeOperation: 'dispatch', queuedConversations: 0, queuedDispatches: 2,
      entries: [
        { dispatchId: 'one', enqueuedAt: message.occurredAt, scope: { namespace: 'channel', id: 'b' } },
        { dispatchId: 'two', enqueuedAt: message.occurredAt, sessionId: 'private-session' },
      ] }]} />);
  assert.ok(markup.includes('2 queued')); assert.ok(markup.includes('Other Channel'));
  assert.ok(markup.includes('Other session')); assert.ok(!markup.includes('private-session'));
  const queues = [{ petId: 'worker', state: 'waiting' as const, activeOperation: null, queuedConversations: 0, queuedDispatches: 1,
    activeDispatch: { dispatchId: 'active', enqueuedAt: message.occurredAt, sessionId: 'private-session' } }];
  const waiting = renderToStaticMarkup(<ChannelDispatchQueues connected={true} pets={[]} channels={[]} queues={queues} />);
  assert.ok(waiting.includes('>waiting<')); assert.ok(!waiting.includes('review requested'));
  for (const props of [{ connected: false }, { connected: true, error: 'Read unavailable' }]) {
    const stale = renderToStaticMarkup(<ChannelDispatchQueues {...props} pets={[]} channels={[]} queues={queues} />);
    assert.ok(stale.includes('status unknown')); assert.ok(stale.includes('Last observed'));
    assert.ok(!stale.includes('Working')); assert.ok(!stale.includes('private-session'));
  }
});

test('registered names are consistent while routing IDs, duplicates and removed history remain distinguishable', () => {
  const pets = [{ petId: 'worker', name: 'Analyst' }, { petId: 'reviewer', name: 'Analyst' }, { petId: 'planner', name: 'Planner' }];
  assert.deepEqual(channelPetIdentity('worker', pets), { name: 'Analyst', removed: false, optionLabel: 'Analyst (worker)' });
  assert.equal(channelPetIdentity('planner', pets).optionLabel, 'Planner');
  assert.equal(channelMessageIdentity(message, pets).name, 'Analyst');
  assert.deepEqual(channelPetIdentity('retired', pets), { name: 'retired', removed: true, optionLabel: 'retired' });
  assert.equal(channelPetIdentity('worker', [], false).removed, false, 'a registry still loading is not proof of removal');
  assert.equal(channelMessageInput('a', 'pet:worker', 'next').mentions?.[0]?.participantId, 'pet:worker', 'presentation cannot change routing');
});

test('grouping applies only to nearby notes and keeps request, reply, output and date boundaries', () => {
  const note = { ...message, source: undefined, author: { kind: 'human', id: 'owner' }, occurredAt: '2026-10-04T00:00:00Z' };
  const next = { ...note, messageId: 'next', occurredAt: '2026-10-04T00:01:00Z' };
  assert.equal(channelMessagesGroup(note, next, []), true);
  assert.equal(channelMessagesGroup(note, { ...next, replyTo: 'm' }, []), false);
  assert.equal(channelMessagesGroup(note, { ...next, source: message.source }, []), false);
  assert.equal(channelMessagesGroup(note, next, [{ ...execution, messageId: 'next' }]), false);
  assert.equal(channelMessagesGroup(note, { ...next, occurredAt: '2026-10-05T00:01:00Z' }, []), false);
  assert.equal(channelMessagesGroup(note, { ...next, occurredAt: '2026-10-04T00:06:00Z' }, []), false);
  assert.equal(channelMessagesGroup(note, { ...next, author: { kind: 'human', id: 'other' } }, []), false);
});

test('request and output associations require matching stored invocation, Pet, session and Channel', () => {
  const run = { ...execution, messageId: 'request', invocationId: 'i' };
  const request = { ...message, source: undefined, messageId: 'request' };
  assert.equal(channelMessageExecution(request, [run]), run);
  assert.equal(channelMessageExecution(message, [run]), run);
  assert.deepEqual(channelExecutionOutputs(run, [request, message]), [message]);
  for (const source of [{ ...message.source!, sessionId: 'wrong' }, { ...message.source!, petId: 'wrong' }, { ...message.source!, invocationId: 'wrong' }]) {
    assert.equal(channelMessageExecution({ ...message, source }, [run]), undefined);
    assert.deepEqual(channelExecutionOutputs(run, [{ ...message, source }]), []);
  }
  assert.deepEqual(channelExecutionOutputs(run, [{ ...message, channelId: 'other' }]), []);
});

test('references show one compact quote without truncating the public delivery or losing message anchors', () => {
  const original = { ...message, body: 'Full evidence. '.repeat(40) };
  const response = { ...message, messageId: 'reply', replyTo: original.messageId, body: 'Use this evidence.' };
  assert.ok(channelQuote(original.body).length <= 160);
  const markup = renderToStaticMarkup(<ChannelTimeline entries={[original, response]} pets={[{ petId: 'worker', name: 'Analyst' }]} pending={false} onReply={() => undefined} />);
  assert.ok(markup.includes(original.body.trim()));
  assert.ok(markup.includes('id="message-reply"')); assert.ok(markup.includes('id="message-m"'));
  assert.equal((markup.match(/class="channel-quote"/g) ?? []).length, 1);
  assert.ok(markup.includes('Analyst')); assert.ok(markup.includes('<time'));
});

test('unfinished observations become unknown after disconnection or restart; waiting is historical guidance', () => {
  assert.equal(executionLabel(execution, false), 'status unknown');
  assert.equal(executionLabel({ ...execution, observationLost: true }, true), 'status unknown');
  assert.equal(executionLabel({ ...execution, state: 'completed' }, false), 'invocation ended');
  assert.equal(executionLabel({ ...execution, state: 'waiting' }, true), 'review requested');
  const markup = renderToStaticMarkup(<ChannelExecutionHistory connected={true} executions={[
    { ...execution, state: 'waiting' }, { ...execution, executionId: 'f', state: 'failed', error: 'Provider returned 403.' },
    { ...execution, executionId: 'd', state: 'completed', deliveryError: 'disk unavailable' },
  ]} />);
  assert.ok(markup.includes('Provider returned 403.')); assert.ok(markup.includes('disk unavailable'));
  assert.ok(markup.includes('worker:same')); assert.ok(markup.includes('not the current approval state'));
});
