import type {
  LocalAgentEvent,
  LocalAgentOperationEvent,
} from '../events/localAgentEvent';
import type { LocalAgentEventMessage } from '../localAgentProtocol';

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

type WsLike = {
  readyState: number;
  send(data: string): unknown;
};

const WS_OPEN = 1;

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

export function sendLocalAgentCompatibilityEvent(ws: WsLike, event: LocalAgentEvent) {
  if (ws.readyState !== WS_OPEN) {
    return false;
  }
  ws.send(JSON.stringify({
    type: 'event',
    requestId: event.requestId,
    event,
  } satisfies LocalAgentEventMessage));
  const legacyMessage = buildLegacyServerMessageFromLocalAgentEvent(event);
  if (legacyMessage) {
    ws.send(JSON.stringify(legacyMessage));
  }
  return true;
}
