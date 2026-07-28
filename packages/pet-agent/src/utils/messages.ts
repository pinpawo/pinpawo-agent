import type { BaseMessage } from '@langchain/core/messages';

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
  if (Array.isArray(record.tool_calls)) {
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
