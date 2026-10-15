import type { BaseMessage } from '@langchain/core/messages';
import { readMessageToolCallIds, readToolResultCallId } from '../../utils/messages';

export type ToolProtocolSafeResult = {
  messages: BaseMessage[];
  removedMessageIds: string[];
};

function messageIdentity(message: BaseMessage, index: number) {
  return message.id ?? `index:${index.toString()}`;
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
      if (message._getType() !== 'tool') {
        safeMessages.push(message);
      } else {
        removedMessageIds.push(messageIdentity(message, index));
      }
      index += 1;
      continue;
    }

    const followingToolMessages: BaseMessage[] = [];
    const answeredToolCallIds = new Set<string>();
    let nextIndex = index + 1;
    while (nextIndex < messages.length && messages[nextIndex]!._getType() === 'tool') {
      const toolMessage = messages[nextIndex]!;
      followingToolMessages.push(toolMessage);
      const toolCallId = readToolResultCallId(toolMessage);
      if (toolCallId) answeredToolCallIds.add(toolCallId);
      nextIndex += 1;
    }

    if (toolCallIds.every((toolCallId) => answeredToolCallIds.has(toolCallId))) {
      safeMessages.push(message, ...followingToolMessages);
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
