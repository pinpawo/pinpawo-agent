import type { BaseMessage } from '@langchain/core/messages';
import type { ToolLogPhase } from './localAgentProtocol';

export type StreamToolsPayload = {
  event: 'on_tool_start' | 'on_tool_event' | 'on_tool_end' | 'on_tool_error';
  toolCallId?: string;
  name: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  data?: unknown;
};

export type ToolLogMessagePayload = {
  type: 'tool_log';
  requestId: string;
  phase: ToolLogPhase;
  toolName: string;
  toolCallId?: string;
  input?: string;
  output?: string;
  error?: string;
};

export function readFinalMessageText(message: { content?: unknown }) {
  const content = message.content;
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('\n')
      .trim();
  }
  return '';
}

export function readMessageChunkText(message: { content?: unknown }) {
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

export function readStreamNode(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || !('langgraph_node' in metadata)) {
    return null;
  }
  const node = metadata.langgraph_node;
  return typeof node === 'string' ? node : null;
}

export function isLaneTaggedAiMessage(message: BaseMessage) {
  const pinpawo = message.additional_kwargs?.pinpawo;
  return Boolean(pinpawo && typeof pinpawo === 'object' && 'lane' in pinpawo);
}

export function stringifyToolData(value: unknown) {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object') {
    const content = (value as { content?: unknown }).content;
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((part) => (typeof part === 'string' ? part : ((part as { text?: string }).text ?? '')))
        .join('');
    }
  }
  try {
    return JSON.stringify(value ?? '');
  } catch {
    return String(value);
  }
}

export function buildToolLogMessage(requestId: string, payload: StreamToolsPayload): ToolLogMessagePayload {
  const phase: ToolLogPhase = payload.event === 'on_tool_start'
    ? 'start'
    : payload.event === 'on_tool_end'
      ? 'end'
      : payload.event === 'on_tool_error'
        ? 'error'
        : 'event';
  const input = payload.input !== undefined ? stringifyToolData(payload.input) : undefined;
  const output = payload.output !== undefined
    ? stringifyToolData(payload.output)
    : payload.data !== undefined
      ? stringifyToolData(payload.data)
      : undefined;
  const error = payload.error !== undefined ? stringifyToolData(payload.error) : undefined;

  return {
    type: 'tool_log',
    requestId,
    phase,
    toolName: payload.name,
    toolCallId: payload.toolCallId,
    input,
    output,
    error,
  };
}
