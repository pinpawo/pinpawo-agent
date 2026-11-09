import assert from 'node:assert/strict';

type Author = { participantId: string; kind: 'human' | 'pet'; label?: string };
export type ChannelTestInput = {
  type: 'channel_message'; version: 1; channelId: string; messageId: string;
  author: Author; body: string;
  replyTo?: { messageId: string; author: Author; body: string };
  addressedBy?: 'routing';
  contextHint?: { source: 'channel-routing'; action: 'read-latest-channel'; focus?: string };
};
export type ChannelTestTask = {
  type: 'channel_task'; version: 1; channelId: string;
  origin: { kind: 'scheduler' | 'trigger'; id: string }; body: string;
};

function readFenced(text: string): Record<string, unknown> {
  const lines = text.split('\n');
  const opening = lines.shift()!;
  const closing = lines.pop()!;
  assert.ok(opening.endsWith('json'));
  assert.equal(opening.slice(0, -4), closing);
  assert.ok(/^`{3,}$/.test(closing));
  const input = JSON.parse(lines.join('\n')) as Record<string, unknown>;
  assert.equal(input.version, 1);
  assert.equal(typeof input.channelId, 'string');
  if (input.type !== 'channel_batch') assert.equal(typeof input.body, 'string');
  return input;
}

/** Decode the domain payload in deterministic graphs, never in production Host. */
export function readChannelTestInput(text: string): ChannelTestInput {
  const input = readFenced(text) as ChannelTestInput;
  assert.equal(input.type, 'channel_message');
  assert.ok(input.messageId && input.author.participantId);
  return input;
}

/** A scheduled or triggered instruction: no author, no Channel message. */
export function readChannelTestTask(text: string): ChannelTestTask {
  const input = readFenced(text) as ChannelTestTask;
  assert.equal(input.type, 'channel_task');
  assert.ok(!Object.hasOwn(input, 'author') && !Object.hasOwn(input, 'messageId'));
  assert.ok(input.origin.kind && input.origin.id);
  return input;
}

export type ChannelTestBatch = {
  type: 'channel_batch'; version: 1; channelId: string; petParticipantId: string; membershipId: string;
  range: { after: number; through: number };
  messages: Array<{ messageId: string; sequence: number; author: Author; body: string; mentions: Array<{ participantId: string }>; replyTo?: { messageId: string; author: Author; body: string }; deliverables?: unknown[]; source?: string }>;
  headReply?: { messageId: string; author: Author; body: string; source?: string };
  contextHint: { source: 'channel-head'; action: 'read-latest-channel'; focus?: string };
};
export function readChannelTestBatch(text: string): ChannelTestBatch {
  const input = readFenced(text) as ChannelTestBatch;
  assert.equal(input.type, 'channel_batch');
  assert.ok(input.membershipId && input.petParticipantId && input.messages.length);
  return input;
}
