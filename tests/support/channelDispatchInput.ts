import assert from 'node:assert/strict';

type Author = { participantId: string; kind: 'human' | 'pet' | 'bot' };
export type ChannelTestInput = {
  type: 'channel_message'; version: 1; channelId: string; messageId: string;
  author: Author; body: string;
  replyTo?: { messageId: string; author: Author; body: string };
};

/** Decode the domain payload in deterministic graphs, never in production Host. */
export function readChannelTestInput(text: string): ChannelTestInput {
  const lines = text.split('\n');
  const opening = lines.shift()!;
  const closing = lines.pop()!;
  assert.ok(opening.endsWith('json'));
  assert.equal(opening.slice(0, -4), closing);
  assert.ok(/^`{3,}$/.test(closing));
  const input = JSON.parse(lines.join('\n')) as ChannelTestInput;
  assert.equal(input.type, 'channel_message');
  assert.equal(input.version, 1);
  assert.ok(input.messageId && input.channelId && input.author.participantId);
  assert.equal(typeof input.body, 'string');
  return input;
}
