import type { BaseMessage } from '@langchain/core/messages';

export type ToolCallInfo = {
  id: string;
  name: string;
  args: unknown;
};

export function readToolCalls(message: BaseMessage): ToolCallInfo[] {
  return readRawToolCalls(message).flatMap((call) => {
    if (!call || typeof call !== 'object') return [];
    const item = call as Record<string, unknown>;
    const id = item.id;
    const functionCall = item.function && typeof item.function === 'object'
      ? item.function as Record<string, unknown>
      : null;
    const name = typeof item.name === 'string' ? item.name : functionCall?.name;
    return typeof id === 'string' && id && typeof name === 'string' && name
      ? [{ id, name, args: item.args ?? readFunctionCallArguments(functionCall?.arguments) }]
      : [];
  });
}

export function readToolCallIds(message: BaseMessage): string[] {
  return readRawToolCalls(message).flatMap((call) => {
    if (!call || typeof call !== 'object') return [];
    const id = (call as Record<string, unknown>).id;
    return typeof id === 'string' && id ? [id] : [];
  });
}

export function messageHasToolCalls(message: BaseMessage) {
  return readToolCallIds(message).length > 0;
}

export function readToolMessageCallId(message: BaseMessage): string | null {
  if (message._getType() !== 'tool') return null;
  const toolCallId = (message as BaseMessage & { tool_call_id?: unknown }).tool_call_id;
  return typeof toolCallId === 'string' && toolCallId ? toolCallId : null;
}

function readRawToolCalls(message: BaseMessage): unknown[] {
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
