import { channelParticipantId } from './channelParticipants';
import type { ChannelMessageRow } from './store/channelStore';

/** Who started a Pet's spontaneous run in a Channel. */
export type ChannelRunOrigin = { kind: 'scheduler' | 'trigger'; id: string };

// Plugin-owned guidance, not the decider's free-form reason or message content.
const routingContextHint = {
  source: 'channel-routing',
  action: 'read-latest-channel',
  instruction: '请通过可用的 channel_read_context 工具，或 Pet 已配置的 channel_context Capability，读取最新相关 Channel 消息；结合已有完成结果与后续更正，判断当前是否仍需行动，再继续。缺少读取能力时说明所缺背景，不猜测。',
} as const;

function fenced(input: Record<string, unknown>): string {
  const text = JSON.stringify(input, null, 2);
  // A copied envelope is quoted data, not another active handoff. Body content
  // cannot close the fence or replace the server-assigned top-level fields.
  let length = 3;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = '`'.repeat(length);
  return `${fence}json\n${text}\n${fence}`;
}

/**
 * Built only from stored messages whose authors were assigned by Channel / Host.
 * The participantId is the author's identity; the label, when the author is
 * still a member, is only how to call them.
 */
export function channelDispatchInput(
  message: ChannelMessageRow,
  original?: ChannelMessageRow,
  labelOf: (participantId: string) => string | undefined = () => undefined,
  /** `routing`: nobody addressed this message; Channel routing chose this Pet. */
  addressedBy?: 'routing',
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
    ...(original ? { replyTo: { messageId: original.messageId, author: author(original), body: original.body } } : {}),
    ...(addressedBy ? { addressedBy, contextHint: routingContextHint } : {}),
  });
}

/** A scheduled or triggered instruction for a Pet in its Channel. It has no author and is not a Channel message. */
export function channelTaskInput(channelId: string, origin: ChannelRunOrigin, body: string): string {
  return fenced({ type: 'channel_task', version: 1, channelId, origin: { kind: origin.kind, id: origin.id }, body });
}
