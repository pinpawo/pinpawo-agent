import assert from 'node:assert/strict';
import type { HeadMessage } from '../../../../packages/studio/src/host/petHead';

export type ChannelEnvelope = { type: 'channel_message'; version: 1; message: HeadMessage; referencedMessage?: HeadMessage };

/** Read canonical Channel input on the provider wire, not a Head-generated work summary. */
export function readChannelEnvelope<T extends { role: string; content?: unknown }>(messages: readonly T[], text: (value: unknown) => string): ChannelEnvelope | undefined {
  for (const item of [...messages].reverse()) {
    if (item.role !== 'user') continue;
    const match = /^(`{3,})json\n([\s\S]*?)\n\1(?:\n|$)/m.exec(text(item.content));
    if (!match) continue;
    let value: ChannelEnvelope;
    try { value = JSON.parse(match[2]!); } catch { continue; }
    if (value?.type !== 'channel_message') continue;
    assert.deepEqual(Object.keys(value).sort(), value.referencedMessage
      ? ['message', 'referencedMessage', 'type', 'version'] : ['message', 'type', 'version']);
    assert.equal(value.version, 1);
    assert.equal(typeof value.message.messageId, 'string');
    assert.equal(typeof value.message.body, 'string');
    return value;
  }
}
