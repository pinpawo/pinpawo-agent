import { channelParticipantId } from './channelParticipants';
import type { ChannelMessage } from './channelService';

/** Built only from stored messages whose authors were assigned by Channel / Host. */
export function channelDispatchInput(message: ChannelMessage, original?: ChannelMessage): string {
  const author = (entry: ChannelMessage) => ({
    participantId: channelParticipantId(entry.author.kind, entry.author.id), kind: entry.author.kind,
  });
  const input = JSON.stringify({
    type: 'channel_message', version: 1,
    channelId: message.channelId, messageId: message.messageId,
    author: author(message), body: message.body,
    ...(original ? { replyTo: { messageId: original.messageId, author: author(original), body: original.body } } : {}),
  }, null, 2);
  // A copied envelope is quoted data, not another active handoff. Body content
  // cannot close the fence or replace the server-assigned top-level author.
  let length = 3;
  for (const match of input.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = '`'.repeat(length);
  return `${fence}json\n${input}\n${fence}`;
}
