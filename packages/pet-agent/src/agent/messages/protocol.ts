import { AIMessage, type BaseMessage, type ToolCall } from '@langchain/core/messages';
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

/**
 * Copy an AI message with its tool calls replaced.
 *
 * A message from a streamed turn also carries the provider's calls as
 * `tool_call` content blocks (and raw `additional_kwargs.tool_calls`), and
 * LangChain merges those blocks back into `tool_calls` when it rebuilds the
 * message. Setting `tool_calls` alone would then leave every rewritten call
 * next to its original ID, so the provider's copies are dropped here and the
 * replacement calls stand alone.
 */
export function withToolCalls(message: AIMessage, toolCalls: ToolCall[]) {
  const { tool_calls: _providerCalls, ...additionalKwargs } = message.additional_kwargs ?? {};
  return new AIMessage({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.filter((block) => !['tool_call', 'tool_call_chunk'].includes((block as { type?: string }).type ?? ''))
      : message.content,
    additional_kwargs: additionalKwargs,
    tool_calls: toolCalls,
  });
}
