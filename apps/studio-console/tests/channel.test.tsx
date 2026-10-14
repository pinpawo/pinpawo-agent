import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  appendChannelDeliveries, channelJoinablePets, channelMentionLabel, channelMessageIdentity, channelMessageInput, channelMessagesGroup,
  channelMessageSummary, channelParticipantId, channelPetIdentity, channelPetSession, channelQuote, channelReplyRecipientId,
  readChannelContext, readChannelPages, type ChannelMember, type ChannelMessage,
} from '../src/channelData';
import { ChannelTimeline } from '../src/ChannelPanel';
import { ChannelMessageMarkdown } from '../src/ChannelConversation';
import { ChannelDispatchQueues } from '../src/ChannelDispatchQueues';

const message: ChannelMessage = { channelId: 'a', sequence: 2, messageId: 'm', body: 'Full public delivery.\n\nMissing work remains.\n\n```ts\nconst evidence = 42;\n```',
  author: { kind: 'pet', id: 'worker' }, occurredAt: '2026-10-04T00:00:00Z', externalRef: 'session-message-1',
  artifacts: [{ uri: 'javascript:alert(1)', label: 'unsafe' }], mentions: [] };
const members: ChannelMember[] = [
  { participantId: 'human:studio-operator', kind: 'human', id: 'studio-operator', label: 'studio-operator' },
  { participantId: 'pet:worker', kind: 'pet', id: 'worker', label: 'Analyst' },
];

test('Reply defaults to the original author while it is a member; changes and clearing stay explicit', () => {
  const current = [...members, { participantId: 'pet:a%29b', kind: 'pet', id: 'a)b', label: 'Analyst' }, { participantId: 'human:worker', kind: 'human', id: 'worker', label: 'worker' }];
  const target = channelReplyRecipientId(message.author, current);
  assert.equal(target, 'pet:worker');
  assert.deepEqual(channelMessageInput('a', target, 'next', message).mentions, [{ participantId: 'pet:worker' }]);
  assert.equal(channelReplyRecipientId({ kind: 'pet', id: 'a)b' }, current), 'pet:a%29b');
  assert.equal(channelReplyRecipientId({ kind: 'human', id: 'worker' }, current), 'human:worker');
  assert.equal(channelReplyRecipientId({ kind: 'pet', id: 'former' }, current), '', 'a former member is never guessed as recipient');
  assert.equal(channelReplyRecipientId(undefined, current), '');
  assert.deepEqual(channelMessageInput('a', '', 'saved', message), { channelId: 'a', body: 'saved', replyTo: 'm' });
  assert.deepEqual(channelMessageInput('a', 'pet:other', ' answer ', message), {
    channelId: 'a', body: 'answer', mentions: [{ participantId: 'pet:other' }], replyTo: 'm',
  });
  assert.throws(() => channelMessageInput('b', '', 'reply', message), /outside/);
  assert.throws(() => channelMessageInput('a', 'pet:worker', '   '), /message/);
});

test('history loading follows every cursor and fails on a nonadvancing page', async () => {
  const paths: string[] = [];
  const values = await readChannelPages<string>(async path => {
    paths.push(path);
    return paths.length === 1 ? { channels: ['old'], nextAfter: 200, hasMore: true } : { channels: ['recent'], nextAfter: 201, hasMore: false };
  }, '/channels', 'channels');
  assert.deepEqual(values, ['old', 'recent']);
  assert.equal(paths[1], '/channels?after=200&limit=200');
  await assert.rejects(readChannelPages(async () => ({ channels: [], nextAfter: 0, hasMore: true }), '/channels', 'channels'), /advance/);
});

test('context reads every message page and keeps the latest members', async () => {
  const channel = { channelId: 'a b', title: 'T', createdBy: { kind: 'human', id: 'studio-operator' }, createdAt: 'now', updatedAt: 'now' };
  const paths: string[] = [];
  const context = await readChannelContext(async path => {
    paths.push(path);
    return paths.length === 1
      ? { channel, members: members.slice(0, 1), messages: [message], nextAfter: 2, hasMore: true, viewerParticipantId: 'human:studio-operator' }
      : { channel, members, messages: [{ ...message, messageId: 'n', sequence: 3 }], nextAfter: 3, hasMore: false, viewerParticipantId: 'human:studio-operator' };
  }, 'a b');
  assert.deepEqual(paths, ['/channels/context?channelId=a%20b&after=0&limit=200', '/channels/context?channelId=a%20b&after=2&limit=200']);
  assert.deepEqual(context.messages.map(item => item.messageId), ['m', 'n']);
  assert.equal(context.members.length, 2);
  await assert.rejects(readChannelContext(async () => ({ messages: [], nextAfter: 0, hasMore: false }), 'a'), /Invalid Channel context/);
});

test('timeline renders the stored body and safe references; every message offers reply', () => {
  const markup = renderToStaticMarkup(<ChannelTimeline messages={[message, { ...message, messageId: 'note', author: { kind: 'human', id: 'owner' }, body: '<script>bad()</script>' }]}
    pending={false} onReply={() => undefined} />);
  assert.ok(markup.includes('Missing work remains.')); assert.ok(markup.includes('evidence = 42'));
  assert.equal((markup.match(/>Reply to /g) ?? []).length, 2);
  assert.ok(!markup.includes('href="javascript:')); assert.ok(!markup.includes('<script>'));
  assert.ok(!markup.includes('Tool calls'), 'Channel messages carry no tool calls');
});

test('mentions and authors are named from current members; the viewer is Me', () => {
  const human = { ...message, author: { kind: 'human', id: 'studio-operator' }, mentions: [{ participantId: 'pet:worker', label: 'Old label' }] };
  const markup = renderToStaticMarkup(<ChannelTimeline messages={[human]} pending={false} onReply={() => undefined}
    members={members} viewerParticipantId="human:studio-operator" />);
  assert.ok(markup.includes('Me')); assert.ok(markup.includes('@Analyst'));
  assert.equal(channelMentionLabel({ participantId: 'pet:gone', label: 'Stored label' }, members), 'Stored label', 'a former member keeps its stored label');
  assert.equal(channelMentionLabel({ participantId: 'pet:gone' }, members), 'pet:gone');
});

test('delivery outcomes observed by the Console show next to their message without being stored', () => {
  const human = { ...message, author: { kind: 'human', id: 'studio-operator' } };
  const deliveries = appendChannelDeliveries([
    { channelId: 'a', messageId: 'm', participantId: 'pet:worker', state: 'accepted', invocationId: 'i-1' },
  ], [
    { channelId: 'a', messageId: 'm', participantId: 'pet:worker', state: 'failed', error: 'Admission denied.' },
    { channelId: 'a', messageId: 'm', state: 'failed', error: 'Unknown Channel participant "pet:x".' },
    { channelId: 'b', messageId: 'm', participantId: 'pet:worker', state: 'accepted' },
  ]);
  assert.equal(deliveries.length, 3, 'a later outcome replaces the earlier one for the same recipient');
  const markup = renderToStaticMarkup(<ChannelTimeline messages={[human]} pending={false} onReply={() => undefined}
    members={members} viewerParticipantId="human:studio-operator" deliveries={deliveries} />);
  assert.ok(markup.includes('Analyst · failed')); assert.ok(markup.includes('Admission denied.'));
  assert.ok(markup.includes('Mentions were not delivered: Unknown Channel participant'));
  assert.ok(!markup.includes('dispatch accepted'), 'outcomes from another Channel stay there');
  const accepted = renderToStaticMarkup(<ChannelTimeline messages={[human]} pending={false} onReply={() => undefined} members={members}
    deliveries={[{ channelId: 'a', messageId: 'm', participantId: 'pet:worker', state: 'accepted' }]} />);
  assert.ok(accepted.includes('Analyst · dispatch accepted'));
});

test('a Pet message opens its Channel session only once that session is registered', () => {
  const sessions = [{ channelId: 'a', petId: 'worker', sessionId: 'worker:0001', registered: true }];
  const opened: string[] = [];
  const markup = renderToStaticMarkup(<ChannelTimeline messages={[message, { ...message, messageId: 'h', author: { kind: 'human', id: 'studio-operator' } }]}
    pending={false} onReply={() => undefined} members={members} sessions={sessions} onViewSession={session => opened.push(session.sessionId)} />);
  assert.equal((markup.match(/>View Analyst session</g) ?? []).length, 1);
  assert.equal(channelPetSession('worker', sessions)?.sessionId, 'worker:0001');
  assert.equal(channelPetSession('worker', [{ ...sessions[0]!, registered: false }]), undefined);
  const unregistered = renderToStaticMarkup(<ChannelTimeline messages={[message]} pending={false} onReply={() => undefined}
    members={members} sessions={[{ ...sessions[0]!, registered: false }]} onViewSession={() => undefined} />);
  assert.ok(!unregistered.includes('session<'));
});

test('global queue rendering uses runtime entries from every Channel and hides private request context', () => {
  const markup = renderToStaticMarkup(<ChannelDispatchQueues connected={true} pets={[{ petId: 'worker', name: 'Worker' }]}
    channels={[{ channelId: 'b', title: 'Other Channel', createdBy: { kind: 'human', id: 'owner' }, createdAt: 'now', updatedAt: 'now' }]}
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

test('registered names are consistent while routing IDs, duplicates and former members remain distinguishable', () => {
  const pets = [{ petId: 'worker', name: 'Analyst' }, { petId: 'reviewer', name: 'Analyst' }, { petId: 'planner', name: 'Planner' }];
  assert.deepEqual(channelPetIdentity('worker', pets), { name: 'Analyst', removed: false, optionLabel: 'Analyst (worker)' });
  assert.equal(channelPetIdentity('planner', pets).optionLabel, 'Planner');
  assert.equal(channelMessageIdentity(message, pets).name, 'Analyst');
  assert.deepEqual(channelPetIdentity('retired', pets), { name: 'retired', removed: true, optionLabel: 'retired' });
  assert.equal(channelPetIdentity('worker', [], false).removed, false, 'a registry still loading is not proof of removal');
  const current = [
    { participantId: 'human:operator%29', kind: 'human', id: 'operator)', label: 'operator)' },
    { participantId: 'pet:a%29b', kind: 'pet', id: 'a)b', label: 'Analyst' },
  ];
  assert.equal(channelParticipantId({ kind: 'pet', id: 'a)b' }), 'pet:a%29b');
  assert.equal(channelMessageIdentity({ author: { kind: 'human', id: 'operator)' } }, pets, true, current, 'human:operator%29').name, 'Me');
  assert.equal(channelMessageIdentity({ author: { kind: 'pet', id: 'a)b' } }, [], true, current).name, 'Analyst');
  assert.equal(channelMessageIdentity({ author: { kind: 'human', id: 'former' } }, pets, true, current).name, 'former');
  assert.deepEqual(channelJoinablePets(pets, [{ participantId: 'pet:worker', kind: 'pet', id: 'worker', label: 'Analyst' }, { participantId: 'human:planner', kind: 'human', id: 'planner', label: 'planner' }])
    .map(pet => pet.petId), ['reviewer', 'planner'], 'a human with a Pet\'s id does not make that Pet a member');
});

test('grouping applies only to nearby messages from one author and keeps reply and date boundaries', () => {
  const note = { ...message, author: { kind: 'human', id: 'owner' }, occurredAt: '2026-10-04T00:00:00Z' };
  const next = { ...note, messageId: 'next', occurredAt: '2026-10-04T00:01:00Z' };
  assert.equal(channelMessagesGroup(note, next), true);
  assert.equal(channelMessagesGroup(undefined, next), false);
  assert.equal(channelMessagesGroup(note, { ...next, replyTo: 'm' }), false);
  assert.equal(channelMessagesGroup(note, { ...next, occurredAt: '2026-10-05T00:01:00Z' }), false);
  assert.equal(channelMessagesGroup(note, { ...next, occurredAt: '2026-10-04T00:06:00Z' }), false);
  assert.equal(channelMessagesGroup(note, { ...next, author: { kind: 'human', id: 'other' } }), false);
});

test('references show one compact quote without truncating the message or losing anchors', () => {
  const original = { ...message, body: 'Full evidence. '.repeat(40) };
  const response = { ...message, messageId: 'reply', replyTo: original.messageId, body: 'Use this evidence.' };
  assert.ok(channelQuote(original.body).length <= 160);
  assert.equal(channelMessageSummary(response), 'Use this evidence.');
  const markup = renderToStaticMarkup(<ChannelTimeline messages={[original, response]} pets={[{ petId: 'worker', name: 'Analyst' }]} pending={false} onReply={() => undefined} />);
  assert.ok(markup.includes(original.body.trim()));
  assert.ok(markup.includes('id="message-reply"')); assert.ok(markup.includes('id="message-m"'));
  assert.equal((markup.match(/class="channel-quote"/g) ?? []).length, 1);
  assert.ok(markup.includes('Analyst')); assert.ok(markup.includes('<time'));
});

test('message reader shares safe Markdown and member identity rendering with the Timeline', () => {
  const markup = renderToStaticMarkup(<ChannelMessageMarkdown body={'# Evidence\n\n[Analyst](participant:pet:worker)\n\n| Item | Value |\n| --- | --- |\n| test | passed |\n\n```ts\nconst n = 42;\n```\n\n[unsafe](javascript:alert(1))\n\n<script>bad()</script>'}
    members={members} />);
  assert.ok(markup.includes('<h1>Evidence</h1>'));
  assert.ok(markup.includes('<table>'));
  assert.ok(markup.includes('@Analyst'));
  assert.ok(markup.includes('const n = 42;'));
  assert.ok(!markup.includes('href="participant:'));
  assert.ok(!markup.includes('href="javascript:'));
  assert.ok(!markup.includes('<script>'));
});
