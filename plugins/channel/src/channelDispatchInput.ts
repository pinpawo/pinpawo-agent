/** Who started a Pet's spontaneous run in a Channel. */
export type ChannelRunOrigin = { kind: 'scheduler' | 'trigger'; id: string };
import type { ChannelMessage } from './channelService';

function fenced(input: Record<string, unknown>): string {
  const text = JSON.stringify(input, null, 2);
  // A copied envelope is quoted data, not another active handoff. Body content
  // cannot close the fence or replace the server-assigned top-level fields.
  let length = 3;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = '`'.repeat(length);
  return `${fence}json\n${text}\n${fence}`;
}

/** A scheduled or triggered instruction for a Pet in its Channel. It has no author and is not a Channel message. */
export function channelTaskInput(channelId: string, origin: ChannelRunOrigin, body: string): string {
  return fenced({ type: 'channel_task', version: 1, channelId, origin: { kind: origin.kind, id: origin.id }, body });
}

/** The event's author and references are carried as server-assigned data, not model-generated instructions. */
export function channelMessageInput(message: ChannelMessage, request: string, referencedMessage?: ChannelMessage): string {
  return fenced({ type: 'channel_message', version: 1, message, ...(referencedMessage ? { referencedMessage } : {}), request });
}
