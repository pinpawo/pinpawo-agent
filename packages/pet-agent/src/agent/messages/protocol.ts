import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { readMessageToolCallIds, readToolResultCallId } from '../../utils/messages';
import { getAgentMessageMetadata } from './metadata';

export type ToolProtocolSafeResult = {
  messages: BaseMessage[];
  removedMessageIds: string[];
};

function messageIdentity(message: BaseMessage, index: number) {
  return message.id ?? `index:${index.toString()}`;
}

function hasAttachmentMarker(message: BaseMessage): boolean {
  return HumanMessage.isInstance(message)
    && Object.hasOwn(getAgentMessageMetadata(message), 'toolResultAttachmentCallId');
}

export function makeToolProtocolSafe(
  messages: readonly BaseMessage[],
): ToolProtocolSafeResult {
  const safeMessages: BaseMessage[] = [];
  const removedMessageIds: string[] = [];

  for (let index = 0; index < messages.length;) {
    const message = messages[index]!;
    const toolCallIds = readMessageToolCallIds(message);

    if (toolCallIds.length === 0) {
      if (message._getType() !== 'tool' && !hasAttachmentMarker(message)) {
        safeMessages.push(message);
      } else {
        removedMessageIds.push(messageIdentity(message, index));
      }
      index += 1;
      continue;
    }

    const followingToolMessages: BaseMessage[] = [];
    const followingAttachments: BaseMessage[] = [];
    const expectedToolCallIds = new Set(toolCallIds);
    const answeredToolCallIds = new Set<string>();
    let nextIndex = index + 1;
    while (nextIndex < messages.length) {
      const following = messages[nextIndex]!;
      if (following._getType() === 'tool') {
        followingToolMessages.push(following);
        const toolCallId = readToolResultCallId(following);
        if (toolCallId) answeredToolCallIds.add(toolCallId);
      } else {
        const attachmentCallId = getAgentMessageMetadata(following).toolResultAttachmentCallId;
        // Only an explicitly linked attachment after its receipt can bridge
        // parallel tool results. Ordinary user turns remain hard boundaries.
        if (!hasAttachmentMarker(following) || typeof attachmentCallId !== 'string'
          || !expectedToolCallIds.has(attachmentCallId) || !answeredToolCallIds.has(attachmentCallId)) break;
        followingAttachments.push(following);
      }
      nextIndex += 1;
    }

    if (toolCallIds.every((toolCallId) => answeredToolCallIds.has(toolCallId))) {
      // Providers require all receipts immediately after their AI tool calls.
      // Reorder only this model projection, never the canonical message array.
      safeMessages.push(message, ...followingToolMessages, ...followingAttachments);
    } else {
      removedMessageIds.push(messageIdentity(message, index));
      for (let toolIndex = index + 1; toolIndex < nextIndex; toolIndex += 1) {
        removedMessageIds.push(messageIdentity(messages[toolIndex]!, toolIndex));
      }
    }

    index = nextIndex;
  }

  return { messages: safeMessages, removedMessageIds };
}

export function toolProtocolSafeMessages(messages: readonly BaseMessage[]) {
  return makeToolProtocolSafe(messages).messages;
}
