import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  channelCanEditPrompt, channelInactivePets, channelMemberRemovalInput, channelInlineMentionIds, channelPetCreateInput, channelMentionLabel, channelMentionMarkdown, channelMentionMatches, channelMessageIdentity, channelMessageInput, channelMessagesGroup,
  channelMessageSummary, channelParticipantId, channelPetIdentity, channelPetSession, channelQuote, channelReplyRecipientId,
  channelWindowAfterEarlier, channelWindowAfterLater, channelWorkingLabel, mergeChannelMessages, readChannelContext, readChannelLater, readChannelPages, type ChannelMember, type ChannelMessage,
} from '../src/channelData';
import { ChannelDispatchFailures, ChannelTimeline } from '../src/ChannelPanel';
import { ChannelMessageMarkdown } from '../src/ChannelConversation';
import { dispatchRecordFromEvent } from '../src/dispatchActivity';
import { ChannelDispatchQueues } from '../src/ChannelDispatchQueues';

const message: ChannelMessage = { channelId: 'a', sequence: 2, messageId: 'm', body: 'Full public delivery.\n\nMissing work remains.\n\n```ts\nconst evidence = 42;\n```',
  author: { kind: 'pet', id: 'worker' }, occurredAt: '2026-10-04T00:00:00Z', externalRef: 'session-message-1',
  mentions: [] };
const members: ChannelMember[] = [
  { participantId: 'human:studio-operator', kind: 'human', id: 'studio-operator', label: 'studio-operator' },
  { participantId: 'pet:worker', kind: 'pet', id: 'worker', label: 'Analyst' },
];

test('Channel instructions editing is limited to Studio authority', () => {
  assert.equal(channelCanEditPrompt(true), false, 'ordinary clients may not edit, even on Channels they created');
  assert.equal(channelCanEditPrompt(false), true, 'Studio authority may edit');
});

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

test('context opens on the newest page, reads back one page at a time, and reads on from the newest message held', async () => {
  const channel = { channelId: 'a b', title: 'T', createdBy: { kind: 'human', id: 'studio-operator' }, createdAt: 'now', updatedAt: 'now' };
  const page = (sequences: number[], rest: object) => ({
    channel, members, viewerParticipantId: 'human:studio-operator', hasMore: false, hasEarlier: false,
    messages: sequences.map(sequence => ({ ...message, messageId: `m${sequence}`, sequence })),
    nextAfter: sequences.at(-1) ?? 0, nextBefore: sequences[0] ?? 1, ...rest,
  });
  const paths: string[] = [];
  const newest = await readChannelContext(async path => { paths.push(path); return page([5, 6], { hasEarlier: true }); }, 'a b');
  const earlier = await readChannelContext(async path => { paths.push(path); return page([3, 4], {}); }, 'a b', newest.nextBefore);
  assert.deepEqual(paths, ['/channels/context?channelId=a%20b&limit=100', '/channels/context?channelId=a%20b&before=5&limit=100']);
  assert.equal(newest.hasEarlier, true);

  paths.length = 0;
  const later = await readChannelLater(async path => {
    paths.push(path);
    return paths.length === 1 ? page([7], { hasMore: true, members: members.slice(0, 1) }) : page([8], {});
  }, 'a b', newest.nextAfter);
  assert.deepEqual(paths, ['/channels/context?channelId=a%20b&after=6&limit=200', '/channels/context?channelId=a%20b&after=7&limit=200']);
  assert.equal(later.members.length, 2, 'members come from the last page read');
  const merged = mergeChannelMessages(mergeChannelMessages(earlier.messages, newest.messages), [...later.messages, newest.messages[1]!]);
  assert.deepEqual(merged.map(item => item.sequence), [3, 4, 5, 6, 7, 8]);
  await assert.rejects(readChannelContext(async () => ({ messages: [], nextAfter: 0, hasMore: false }), 'a'), /Invalid Channel context/);
});

test('a late read moves only its own edge of the window it was read for', () => {
  const held = { channelId: 'a', window: 1, nextAfter: 300, nextBefore: 201, hasEarlier: true };
  // An older page landed while a newer read was in flight: the newer read keeps the older edge.
  const afterEarlier = channelWindowAfterEarlier(held, held, { nextBefore: 101, hasEarlier: true })!;
  assert.deepEqual(channelWindowAfterLater(afterEarlier, held, 400), { ...held, nextAfter: 400, nextBefore: 101 });
  // A newer read landed while an older page was in flight: the older page keeps the newer edge.
  const afterLater = channelWindowAfterLater(held, held, 400)!;
  assert.deepEqual(channelWindowAfterEarlier(afterLater, held, { nextBefore: 101, hasEarlier: false }),
    { ...held, nextAfter: 400, nextBefore: 101, hasEarlier: false });
  // The newest page was read afresh (refresh, reopen) or the Channel closed: a read for the old window is dropped.
  const reopened = { ...held, window: 2, nextAfter: 400, nextBefore: 301 };
  assert.equal(channelWindowAfterEarlier(reopened, held, { nextBefore: 101, hasEarlier: true }), undefined);
  assert.equal(channelWindowAfterEarlier(null, held, { nextBefore: 101, hasEarlier: true }), undefined);
  assert.equal(channelWindowAfterLater(reopened, held, 500), undefined);
});

test('timeline renders stored messages without an attachment field and offers reply', () => {
  const markup = renderToStaticMarkup(<ChannelTimeline messages={[message, { ...message, messageId: 'note', author: { kind: 'human', id: 'owner' }, body: '<script>bad()</script>' }]}
    pending={false} onReply={() => undefined} />);
  assert.ok(markup.includes('Missing work remains.')); assert.ok(markup.includes('evidence = 42'));
  assert.equal((markup.match(/aria-label="Reply to /g) ?? []).length, 2);
  assert.ok(!markup.includes('<script>'));
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

test('an @ shows once: inline links stay in the body and only body-less mentions are listed', () => {
  const inline = { ...message, body: '[@Analyst](participant:pet:worker) please check.', mentions: [{ participantId: 'pet:worker' }] };
  const explicit = { ...message, messageId: 'x', body: 'please check.', mentions: [{ participantId: 'pet:worker' }] };
  const markup = renderToStaticMarkup(<ChannelTimeline messages={[inline]} pending={false} onReply={() => undefined} members={members} />);
  assert.equal((markup.match(/@Analyst/g) ?? []).length, 1);
  assert.ok(!markup.includes('Addressed participants'));
  const listed = renderToStaticMarkup(<ChannelTimeline messages={[explicit]} pending={false} onReply={() => undefined} members={members} />);
  assert.ok(listed.includes('Addressed participants')); assert.equal((listed.match(/@Analyst/g) ?? []).length, 1);
  assert.deepEqual([...channelInlineMentionIds('[@A](participant:pet:a) and [@B](participant:human:b%20c)')], ['pet:a', 'human:b%20c']);
});

test('composer @ list matches name or id and serializes to the Channel link', () => {
  const candidates = [
    { participantId: 'human:local', kind: 'human', label: 'Me' },
    { participantId: 'pet:reviewer', kind: 'pet', label: 'Reviewer' },
    { participantId: 'pet:executor', kind: 'pet', label: 'Executor' },
  ];
  assert.deepEqual(channelMentionMatches(candidates, '').map(item => item.label), ['Me', 'Reviewer', 'Executor']);
  assert.deepEqual(channelMentionMatches(candidates, 'e').map(item => item.label), ['Executor', 'Me', 'Reviewer'], 'names starting with the text come first');
  assert.deepEqual(channelMentionMatches(candidates, 'pet:rev').map(item => item.label), ['Reviewer']);
  assert.equal(channelMentionMarkdown({ participantId: 'pet:a', label: 'A [x]\\' }), '[@A x](participant:pet:a)');
  assert.equal(channelMentionMarkdown({ participantId: 'pet:a' }), '[@pet:a](participant:pet:a)');
});

test('a Pet message opens its Channel session only once that session is registered', () => {
  const sessions = [{ channelId: 'a', petId: 'worker', sessionId: 'worker:0001', registered: true }];
  const opened: string[] = [];
  const markup = renderToStaticMarkup(<ChannelTimeline messages={[message, { ...message, messageId: 'h', author: { kind: 'human', id: 'studio-operator' } }]}
    pending={false} onReply={() => undefined} members={members} sessions={sessions} onViewSession={session => opened.push(session.sessionId)} />);
  assert.equal((markup.match(/aria-label="View Analyst session"/g) ?? []).length, 1);
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
  assert.deepEqual(channelPetIdentity('retired', pets), { name: 'retired', removed: false, optionLabel: 'retired' });
  assert.equal(channelPetIdentity('worker', [], false).removed, false, 'a registry still loading is not proof of removal');
  assert.equal(channelPetIdentity('worker', [{ petId: 'worker', name: 'Analyst', closedAt: 't' }]).removed, false);
  assert.equal(channelPetIdentity('worker', [{ petId: 'worker', name: 'Analyst', removedAt: 't' }]).removed, true);
  const current = [
    { participantId: 'human:operator%29', kind: 'human', id: 'operator)', label: 'operator)' },
    { participantId: 'pet:a%29b', kind: 'pet', id: 'a)b', label: 'Analyst' },
  ];
  assert.equal(channelParticipantId({ kind: 'pet', id: 'a)b' }), 'pet:a%29b');
  assert.equal(channelMessageIdentity({ author: { kind: 'human', id: 'operator)' } }, pets, true, current, 'human:operator%29').name, 'Me');
  assert.equal(channelMessageIdentity({ author: { kind: 'pet', id: 'a)b' } }, [], true, current).name, 'Analyst');
  assert.equal(channelMessageIdentity({ author: { kind: 'human', id: 'former' } }, pets, true, current).name, 'former');

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
  assert.equal(channelQuote('[@Alpha](participant:pet:alpha) Continue.'), '@Alpha Continue.', 'a quote shows an @ by name');
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

test('the timeline ends with the Pets running a turn in the Channel, earliest first', () => {
  const working = [
    { participantId: 'pet:reviewer', since: '2026-10-28T00:00:02Z' },
    { participantId: 'pet:worker', since: '2026-10-28T00:00:01Z' },
  ];
  const all = [...members, { participantId: 'pet:reviewer', kind: 'pet', id: 'reviewer', label: 'Reviewer' }];
  assert.equal(channelWorkingLabel(working.slice(1), all), 'Analyst is typing…');
  assert.equal(channelWorkingLabel(working, all), 'Analyst and Reviewer are typing…');
  assert.equal(channelWorkingLabel([...working, { participantId: 'pet:c', since: '3' }, { participantId: 'pet:d', since: '4' }], all),
    'Analyst, Reviewer and 2 others are typing…');
  const markup = renderToStaticMarkup(<ChannelTimeline messages={[message]} pending={false} onReply={() => undefined} members={all} working={working} />);
  assert.match(markup, /<div class="channel-working" role="status">.*Analyst and Reviewer are typing…/);
  assert.ok(markup.indexOf('channel-working') > markup.indexOf('Full public delivery'), 'shown after the newest message');
  assert.doesNotMatch(renderToStaticMarkup(<ChannelTimeline messages={[message]} pending={false} onReply={() => undefined} members={all} />), /channel-working/);
});

test('Channel shows its own execution error without internal IDs or unrelated failures', () => {
  const failure = dispatchRecordFromEvent({ type: 'dispatch.failed', source: 'resident-pet', occurredAt: 'now', payload: {
    invocationId: 'internal-invocation', petId: 'worker', request: 'work', requestId: 'internal-request', sessionId: 'internal-session',
    scope: { namespace: 'channel', id: 'a' }, error: 'terminated',
  } })!;
  const markup = renderToStaticMarkup(<ChannelDispatchFailures channelId="a" pets={[{ petId: 'worker', name: 'Analyst' }]} petsReady={true}
    dispatches={[failure, { ...failure, invocationId: 'other', scope: { namespace: 'channel', id: 'b' }, error: 'Other Channel private' },
      { ...failure, invocationId: 'not-channel', scope: { namespace: 'other', id: 'a' }, error: 'Other scope private' },
      { ...failure, invocationId: 'unscoped', scope: undefined, error: 'Unscoped private' },
      { ...failure, invocationId: 'waiting', state: 'waiting', error: 'Still waiting private' }]} />);
  assert.match(markup, /role="alert"/);
  assert.match(markup, /Analyst execution failed: terminated/);
  assert.doesNotMatch(markup, /internal-|private|<button|reply was not saved|Message was not delivered/);
});

test('Pet creation fixes the owning Channel and allocates a fresh identity per instance', () => {
  const definition = { definitionId: 'developer', name: 'Developer' };
  let serial = 0;
  const newId = () => 'pet-' + ++serial;
  assert.deepEqual(channelPetCreateInput('channel-a', definition, false, newId),
    { petId: 'pet-1', channelId: 'channel-a', definitionId: 'developer', name: 'Developer' });
  assert.equal(channelPetCreateInput('channel-a', definition, false, newId).petId, 'pet-2');
  assert.equal(channelPetCreateInput('channel-b', definition, false, newId).channelId, 'channel-b');
  assert.throws(() => channelPetCreateInput('channel-a', definition, true, newId), /authority/);
  assert.throws(() => channelPetCreateInput('', definition, false, newId), /Channel/);
  assert.equal(serial, 3, 'invalid requests allocate no instance identity');
});


test('Pet creation bounds and normalizes the definition display name', () => {
  assert.equal(channelPetCreateInput('c', { definitionId: 'worker', name: '  Worker  ' }, false, () => 'one').name, 'Worker');
  assert.equal(channelPetCreateInput('c', { definitionId: 'worker', name: '   ' }, false, () => 'two').name, 'worker');
  assert.equal(channelPetCreateInput('c', { definitionId: 'worker', name: 'x'.repeat(100) }, false, () => 'three').name, 'x'.repeat(80));
});


test('inactive Pets stay in their owner Channel and Pet removal alone carries explicit stop consent', () => {
  const records = [
    { petId: 'live', channelId: 'one', name: 'Live' },
    { petId: 'closed', channelId: 'one', name: 'Closed', closedAt: 't' },
    { petId: 'removed', channelId: 'one', name: 'Removed', removedAt: 't' },
    { petId: 'elsewhere', channelId: 'two', name: 'Elsewhere', closedAt: 't' },
  ];
  assert.deepEqual(channelInactivePets(records, 'one').map(pet => pet.petId), ['closed', 'removed']);
  assert.throws(() => channelMemberRemovalInput('one', { kind: 'pet', id: 'live' }, false), /Confirm/);
  assert.deepEqual(channelMemberRemovalInput('one', { kind: 'pet', id: 'live' }, true), { channelId: 'one', kind: 'pet', id: 'live', confirmStop: true });
  assert.deepEqual(channelMemberRemovalInput('one', { kind: 'human', id: 'alice' }, false), { channelId: 'one', kind: 'human', id: 'alice' });
});
