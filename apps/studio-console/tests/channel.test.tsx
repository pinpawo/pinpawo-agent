import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { channelExecuteInput, readChannelPages, executionLabel, type ChannelExecution, type ChannelMessage } from '../src/channelData';
import { ChannelTimeline, ChannelExecutionHistory } from '../src/ChannelPanel';

const message: ChannelMessage = { kind: 'message', channelId: 'a', sequence: 2, messageId: 'm', body: 'Full public delivery.\n\nMissing work remains.\n\n```ts\nconst evidence = 42;\n```',
  author: { kind: 'pet', id: 'worker' }, occurredAt: '2026-10-04T00:00:00Z', revision: 1,
  source: { petId: 'worker', sessionId: 'worker:same', invocationId: 'i' }, artifacts: [{ uri: 'javascript:alert(1)', label: 'unsafe' }], mentions: [] };
const execution: ChannelExecution = { sequence: 1, executionId: 'e', channelId: 'a', petId: 'worker', sessionId: 'worker:same',
  state: 'running', occurredAt: '2026-10-04T00:00:00Z', observationLost: false };

test('explicit execution requires a Pet; reply routing uses source and rejects foreign or unbound messages', () => {
  assert.deepEqual(channelExecuteInput('a', 'worker', ' next '), { channelId: 'a', petId: 'worker', body: 'next' });
  assert.throws(() => channelExecuteInput('a', '', 'next'), /Select a Pet/);
  assert.deepEqual(channelExecuteInput('a', 'other', 'answer', message), { channelId: 'a', replyTo: 'm', body: 'answer' });
  assert.throws(() => channelExecuteInput('b', 'worker', 'answer', message), /this Channel/);
  assert.throws(() => channelExecuteInput('a', 'worker', 'answer', { ...message, source: undefined }), /execution/);
  assert.throws(() => channelExecuteInput('a', 'worker', '   '), /message/);
});

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

test('timeline renders full handoff body and safe references; only execution outputs offer reply', () => {
  const markup = renderToStaticMarkup(<ChannelTimeline entries={[message, { ...message, messageId: 'note', source: undefined, body: '<script>bad()</script>' }]} pending={false} onReply={() => undefined} />);
  assert.ok(markup.includes('Missing work remains.')); assert.ok(markup.includes('evidence = 42'));
  assert.equal((markup.match(/<button/g) ?? []).length, 1);
  assert.ok(!markup.includes('href="javascript:')); assert.ok(!markup.includes('<script>'));
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
