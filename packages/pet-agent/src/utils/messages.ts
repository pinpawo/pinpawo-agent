import { AIMessage, type BaseMessage } from '@langchain/core/messages';

/** Read assistant-visible text without projecting reasoning or tool blocks. */
export function readAiMessageText(message: AIMessage, legacySeparator = ''): string {
  if (Array.isArray(message.content) && message.content.some(part =>
    typeof part === 'string' || (part && typeof part === 'object' && !('type' in part) && 'text' in part))) {
    // LangChain's text projection omits legacy strings and untyped text blocks.
    // Keep those historical shapes while restricting typed blocks to text.
    return (message.contentBlocks as unknown[]).map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && (!('type' in part) || part.type === 'text')
        && 'text' in part && typeof part.text === 'string') return part.text;
      return '';
    }).join(legacySeparator);
  }
  return message.text;
}

/** Identify the two supported representations of a tool call in message content. */
export function isToolCallContentBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false;
  const type = (block as { type?: unknown }).type;
  return type === 'tool_call' || type === 'tool_use';
}

export type MessageToolCallInfo = {
  id: string;
  name: string;
  args: unknown;
};

export function readMessageToolCalls(
  message: BaseMessage,
  options: {
    /**
     * Optional deterministic prefix used to materialize IDs for providers
     * that emit otherwise valid ToolCalls without an id.
     */
    fallbackIdPrefix?: string;
  } = {},
): MessageToolCallInfo[] {
  const rawCalls = readRawMessageToolCalls(message);
  const reservedIds = new Set(rawCalls.flatMap((call) => {
    if (!call || typeof call !== 'object') return [];
    const id = (call as Record<string, unknown>).id;
    return typeof id === 'string' && id ? [id] : [];
  }));
  return rawCalls.flatMap((call, index) => {
    if (!call || typeof call !== 'object') return [];
    const item = call as Record<string, unknown>;
    const functionCall = item.function && typeof item.function === 'object'
      ? item.function as Record<string, unknown>
      : null;
    const name = typeof item.name === 'string' ? item.name : functionCall?.name;
    if (typeof name !== 'string' || !name) return [];
    const rawId = item.id;
    let id = typeof rawId === 'string' && rawId ? rawId : null;
    if (!id && options.fallbackIdPrefix) {
      const base = `${options.fallbackIdPrefix}:${String(index)}`;
      id = base;
      let collisionIndex = 1;
      while (reservedIds.has(id)) {
        id = `${base}:${String(collisionIndex)}`;
        collisionIndex += 1;
      }
      reservedIds.add(id);
    }
    return id
      ? [{
          id,
          name,
          args: item.args ?? readFunctionCallArguments(functionCall?.arguments),
        }]
      : [];
  });
}

export function readMessageToolCallIds(message: BaseMessage): string[] {
  return readRawMessageToolCalls(message).flatMap((call) => {
    if (!call || typeof call !== 'object') return [];
    const id = (call as Record<string, unknown>).id;
    return typeof id === 'string' && id ? [id] : [];
  });
}

export function messageHasToolCalls(message: BaseMessage) {
  return readMessageToolCallIds(message).length > 0;
}

export function readToolResultCallId(message: BaseMessage): string | null {
  if (message._getType() !== 'tool') return null;
  const toolCallId = (message as BaseMessage & { tool_call_id?: unknown }).tool_call_id;
  return typeof toolCallId === 'string' && toolCallId ? toolCallId : null;
}

function readRawMessageToolCalls(message: BaseMessage): unknown[] {
  const record = message as BaseMessage & {
    tool_calls?: unknown;
    additional_kwargs?: { tool_calls?: unknown };
  };
  // Mirror the provider serializer: an empty tool_calls list (every call was
  // malformed JSON, so LangChain moved it to invalid_tool_calls) still sends the
  // raw additional_kwargs calls, which then need results like any other call.
  if (Array.isArray(record.tool_calls) && record.tool_calls.length > 0) {
    return record.tool_calls;
  }
  if (Array.isArray(record.additional_kwargs?.tool_calls)) {
    return record.additional_kwargs.tool_calls;
  }
  return [];
}

function readFunctionCallArguments(value: unknown) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
