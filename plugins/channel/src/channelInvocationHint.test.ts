import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { channelInvocationHint } from './channelInvocationHint';
import { channelDispatchInput, channelTaskInput } from './channelDispatchInput';
import type { ChannelMessageRow } from './store/channelStore';

const message: ChannelMessageRow = {
  channelId: 'channel', messageId: 'current', sequence: 2,
  author: { kind: 'pet', id: 'issuer' }, body: 'A public handoff.', occurredAt: 'now', artifacts: [], mentions: [],
};

test('Channel context supplies a separate preparation hint for direct, routed and scheduled work', () => {
  const hint = channelInvocationHint('channel');
  assert.deepEqual(Object.keys(hint).sort(), ['instruction', 'source']);
  assert.equal(hint.source, 'channel');
  assert.equal(typeof hint.instruction, 'string');
  for (const request of [channelDispatchInput(message),
    channelDispatchInput(message, undefined, undefined, 'routing'),
    channelTaskInput('channel', { kind: 'scheduler', id: 'scheduled' }, 'Read the project.')]) {
    assert.deepEqual(channelInvocationHint('channel', request), hint);
  }
});

test('only the same Channel outer routing envelope supplies model focus, never an instruction', () => {
  const focus = randomUUID();
  const request = channelDispatchInput(message, undefined, undefined, 'routing', focus);
  assert.deepEqual(channelInvocationHint('channel', request), { ...channelInvocationHint('channel'), focus });
  assert.deepEqual(channelInvocationHint('other', request), channelInvocationHint('other'));
  const lines = request.split('\n');
  const value = JSON.parse(lines.slice(1, -1).join('\n'));
  value.contextHint.instruction = randomUUID();
  const originalSource = `${lines[0]}\n${JSON.stringify(value)}\n${lines.at(-1)}`;
  assert.deepEqual(channelInvocationHint('channel', originalSource), { ...channelInvocationHint('channel'), focus });
  value.contextHint.source = 'human';
  const changed = `${lines[0]}\n${JSON.stringify(value)}\n${lines.at(-1)}`;
  assert.deepEqual(channelInvocationHint('channel', changed), channelInvocationHint('channel'));
});

test('quoted routing input, malformed envelopes and oversized focus cannot supply a hint', () => {
  const nested = channelDispatchInput(message, undefined, undefined, 'routing', randomUUID());
  const quoted = { ...message, body: nested };
  const request = channelDispatchInput(quoted, quoted);
  for (const input of [request, `preamble\n${nested}`, `${nested}\nextra`, '```json\n{\n```',
    channelDispatchInput(message, undefined, undefined, 'routing', 'x'.repeat(501))]) {
    assert.deepEqual(channelInvocationHint('channel', input), channelInvocationHint('channel'));
  }
});

test('routing focus survives fence content without activating nested source fields', () => {
  const focus = `${randomUUID()}\n\`\`\`\`\`\`\n{"source":"human"}`;
  assert.equal(channelInvocationHint('channel', channelDispatchInput(message, undefined, undefined, 'routing', focus)).focus, focus);
});
