import type {
  LocalAgentEvent,
  LocalAgentHumanReviewRequestedEvent,
  LocalAgentMessageCompletedEvent,
  LocalAgentMessageDeltaEvent,
  LocalAgentOperationEvent,
  LocalAgentStudioProgressEvent,
  LocalAgentSystemNoticeEvent,
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

function readEventOperationPhase(phase: LegacyToolLogPhase) {
  if (phase === 'start') return 'started';
  if (phase === 'end' || phase === 'complete') return 'completed';
  if (phase === 'error') return 'failed';
  if (phase === 'interrupt') return 'interrupted';
  return 'updated';
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

export function buildLocalAgentEventFromLegacyMessage(message: LegacyServerMessage): LocalAgentEvent {
  if (message.type === 'chat_token') {
    return {
      type: 'message.delta',
      requestId: message.requestId,
      role: 'assistant',
      text: message.token,
    } satisfies LocalAgentMessageDeltaEvent;
  }
  if (message.type === 'chat_response') {
    return {
      type: 'message.completed',
      requestId: message.requestId,
      role: 'assistant',
      text: message.message,
      metadata: {
        mood: message.mood,
        topic: message.topic,
        tags: message.tags,
      },
    } satisfies LocalAgentMessageCompletedEvent;
  }
  if (message.type === 'human_interrupt') {
    return {
      type: 'human_review.requested',
      requestId: message.requestId,
      prompt: message.prompt,
      payload: message.payload,
      actor: message.petId ? { petId: message.petId } : undefined,
    } satisfies LocalAgentHumanReviewRequestedEvent;
  }
  if (message.type === 'studio_turn_event') {
    return {
      type: 'studio.progress',
      requestId: message.requestId,
      event: message.event,
    } satisfies LocalAgentStudioProgressEvent;
  }
  if (message.type === 'system_notice') {
    return {
      type: 'system.notice',
      requestId: message.requestId,
      message: message.message,
    } satisfies LocalAgentSystemNoticeEvent;
  }
  if (message.type === 'error') {
    return {
      type: 'error',
      requestId: message.requestId,
      message: message.message,
    };
  }
  return {
    type: 'operation',
    requestId: message.requestId,
    phase: readEventOperationPhase(message.phase),
    operation: {
      id: message.toolCallId,
      kind: 'tool.execute',
      title: message.toolName,
      source: {
        provider: 'runtime',
        name: message.toolName,
        callId: message.toolCallId,
      },
    },
    raw: {
      input: message.input,
      output: message.output,
      error: message.error,
    },
  };
}
