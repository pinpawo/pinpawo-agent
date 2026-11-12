import assert from 'node:assert/strict';
import { channelParticipantId } from '../../plugins/channel/src/channelParticipants';
import type { ChannelMessageRow } from '../../plugins/channel/src/store/channelStore';

type Author = { participantId: string; kind: 'human' | 'pet'; label?: string };
export type ChannelTestInput = {
  type: 'channel_message'; version: 1; channelId: string; messageId: string;
  author: Author; body: string;
  replyTo?: { messageId: string; author: Author; body: string };
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
  assert.equal(typeof input.body, 'string');
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

function fenced(input: Record<string, unknown>): string {
  const text = JSON.stringify(input, null, 2);
  // Preserve a synthetic body as quoted data, even when it contains fences.
  let length = 3;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = '`'.repeat(length);
  return `${fence}json\n${text}\n${fence}`;
}

/**
 * Test-only synthetic message envelope; do not treat it as proof of author identity.
 */
export function channelDispatchInput(
  message: ChannelMessageRow,
  original?: ChannelMessageRow,
  labelOf: (participantId: string) => string | undefined = () => undefined,
): string {
  const author = (entry: ChannelMessageRow) => {
    const participantId = channelParticipantId(entry.author.kind, entry.author.id);
    const label = labelOf(participantId);
    return { participantId, kind: entry.author.kind, ...(label === undefined ? {} : { label }) };
  };
  return fenced({
    type: 'channel_message', version: 1,
    channelId: message.channelId, messageId: message.messageId,
    author: author(message), body: message.body,
    ...(message.deliverables !== undefined ? { deliverables: message.deliverables } : {}),
    ...(original ? { replyTo: { messageId: original.messageId, author: author(original), body: original.body,
      ...(original.deliverables !== undefined ? { deliverables: original.deliverables } : {}),
    } } : {}),
  });
}
