import type {
  LocalAgentEvent,
  LocalAgentOperationEvent,
} from '../events/localAgentEvent';

export type LegacyToolLogPhase = 'start' | 'end' | 'complete' | 'error' | 'event' | 'interrupt';

/** @deprecated compatibility only; use LocalAgentEvent type: 'operation'. */
export type LegacyToolLogMessagePayload = {
  type: 'tool_log';
  requestId: string;
  phase: LegacyToolLogPhase;
  toolName: string;
  toolCallId?: string;
  input?: string;
  output?: string;
  error?: string;
};

/**
 * @deprecated compatibility only. New local-agent code should emit
 * LocalAgentEvent and let this adapter derive legacy messages only for
 * unmigrated app/API clients.
 */
export type LegacyServerMessage =
  | { type: 'chat_token'; requestId: string; token: string }
  | LegacyToolLogMessagePayload
  | {
      type: 'human_interrupt';
      requestId: string;
      petId?: string;
      prompt: string;
      payload: Record<string, unknown>;
    }
  | { type: 'system_notice'; requestId: string; message: string }
  | {
      type: 'chat_response';
      requestId: string;
      message: string;
      mood: string | null;
      topic: string | null;
      tags: string[];
    }
  | {
      type: 'studio_turn_event';
      requestId: string;
      event: Record<string, unknown>;
    }
  | { type: 'error'; requestId: string; message: string };

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function readOptionalString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readRecord(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readStringArray(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : null;
}

function stringifyLegacyValue(value: unknown) {
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

function readLegacyOperationPhase(event: LocalAgentOperationEvent): LegacyToolLogPhase {
  if (event.phase === 'started') return 'start';
  if (event.phase === 'completed') return 'end';
  if (event.phase === 'failed') return 'error';
  if (event.phase === 'interrupted') return 'interrupt';
  return 'event';
}

function isLegacyToolLogPhase(value: string): value is LegacyToolLogPhase {
  return value === 'start'
    || value === 'end'
    || value === 'complete'
    || value === 'error'
    || value === 'event'
    || value === 'interrupt';
}

export function parseLegacyServerMessageRecord(
  record: Record<string, unknown>,
  requestId: string,
): LegacyServerMessage | null {
  const type = readString(record, 'type');
  if (type === 'chat_token') {
    const token = readString(record, 'token');
    return token == null ? null : { type, requestId, token };
  }
  if (type === 'tool_log') {
    const phase = readString(record, 'phase');
    const toolName = readString(record, 'toolName');
    if (!phase || !isLegacyToolLogPhase(phase) || !toolName) return null;
    return {
      type,
      requestId,
      phase,
      toolName,
      toolCallId: readOptionalString(record, 'toolCallId'),
      input: readOptionalString(record, 'input'),
      output: readOptionalString(record, 'output'),
      error: readOptionalString(record, 'error'),
    };
  }
  if (type === 'human_interrupt') {
    const prompt = readString(record, 'prompt');
    const payload = readRecord(record, 'payload');
    if (prompt == null || !payload) return null;
    return {
      type,
      requestId,
      petId: readOptionalString(record, 'petId'),
      prompt,
      payload,
    };
  }
  if (type === 'system_notice') {
    const message = readString(record, 'message');
    return message == null ? null : { type, requestId, message };
  }
  if (type === 'chat_response') {
    const message = readString(record, 'message');
    const tags = readStringArray(record, 'tags');
    if (message == null || !tags) return null;
    return {
      type,
      requestId,
      message,
      mood: readOptionalString(record, 'mood') ?? null,
      topic: readOptionalString(record, 'topic') ?? null,
      tags,
    };
  }
  if (type === 'studio_turn_event') {
    const event = readRecord(record, 'event');
    return event ? { type, requestId, event } : null;
  }
  if (type === 'error') {
    const message = readOptionalString(record, 'message') ?? '';
    return { type, requestId, message };
  }
  return null;
}

export function buildLegacyToolLogMessage(event: LocalAgentOperationEvent): LegacyToolLogMessagePayload {
  const source = event.operation.source;
  return {
    type: 'tool_log',
    requestId: event.requestId,
    phase: readLegacyOperationPhase(event),
    toolName: source?.name ?? event.operation.title ?? event.operation.kind,
    toolCallId: event.operation.id ?? source?.callId,
    input: event.raw?.input !== undefined ? stringifyLegacyValue(event.raw.input) : undefined,
    output: event.raw?.output !== undefined ? stringifyLegacyValue(event.raw.output) : undefined,
    error: event.raw?.error !== undefined ? stringifyLegacyValue(event.raw.error) : undefined,
  };
}

export function buildLegacyServerMessageFromLocalAgentEvent(event: LocalAgentEvent): LegacyServerMessage | null {
  if (event.type === 'message.delta') {
    return {
      type: 'chat_token',
      requestId: event.requestId,
      token: event.text,
    };
  }
  if (event.type === 'message.completed') {
    return {
      type: 'chat_response',
      requestId: event.requestId,
      message: event.text,
      mood: event.metadata?.mood ?? null,
      topic: event.metadata?.topic ?? null,
      tags: event.metadata?.tags ?? [],
    };
  }
  if (event.type === 'human_review.requested') {
    return {
      type: 'human_interrupt',
      requestId: event.requestId,
      petId: event.actor?.petId,
      prompt: event.prompt,
      payload: event.payload,
    };
  }
  if (event.type === 'studio.progress') {
    return {
      type: 'studio_turn_event',
      requestId: event.requestId,
      event: event.event,
    };
  }
  if (event.type === 'system.notice') {
    return {
      type: 'system_notice',
      requestId: event.requestId,
      message: event.message,
    };
  }
  if (event.type === 'error') {
    return {
      type: 'error',
      requestId: event.requestId,
      message: event.message,
    };
  }
  return buildLegacyToolLogMessage(event);
}
