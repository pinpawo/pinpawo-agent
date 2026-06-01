import type { LocalAgentEvent, LocalAgentOperationPhase } from './events/localAgentEvent';
import {
  buildLocalAgentEventFromLegacyMessage,
  buildLegacyServerMessageFromLocalAgentEvent,
  type LegacyToolLogPhase,
  type LegacyServerMessage,
} from './protocol/legacyProtocolAdapter';

export type ChatRequestMessage = {
  type: 'chat_request';
  requestId: string;
  message: string;
  petId?: string;
  userId?: string;
  resume?: unknown;
};

export type InterruptRequestMessage = {
  type: 'interrupt_request';
  requestId: string;
};

export type NewSessionMessage = {
  type: 'new_session';
  petId?: string;
  userId?: string;
};

export type StudioRequestMessage = {
  type: 'studio_request';
  requestId: string;
  userRequest: string;
  /** 可选:overrides 默认的 conversation 命名,影响 wiki 子目录 */
  conversationId?: string;
};

export type HumanReviewResponseMessage = {
  type: 'human_review_response';
  requestId: string;
  message: string;
  resume?: unknown;
};

export type LocalAgentClientMessage =
  | ChatRequestMessage
  | InterruptRequestMessage
  | NewSessionMessage
  | StudioRequestMessage
  | HumanReviewResponseMessage
  | { type: 'ping' };

export type LocalAgentEventMessage = {
  type: 'event';
  requestId: string;
  event: LocalAgentEvent;
};

export type LocalAgentControlServerMessage =
  | { type: 'pong' }
  | { type: 'interrupting'; requestId: string; message?: string }
  | { type: 'interrupted'; requestId: string; message?: string }
  | {
      type: 'studio_response';
      requestId: string;
      outcome: 'done' | 'stopped';
      reply: string;
      finalDispatchId?: string;
      reason?: string;
    }
  | { type: 'studio_error'; requestId: string; message: string };

export type LocalAgentServerMessage =
  | LocalAgentEventMessage
  | LocalAgentControlServerMessage
  | LegacyServerMessage;

type WsLike = {
  readyState: number;
  send(data: string): unknown;
};

const WS_OPEN = 1;

type SendLocalAgentEventOptions = {
  legacyCompatibility?: boolean;
};

function readJsonRecord(raw: unknown): Record<string, unknown> | null {
  try {
    const text = typeof raw === 'string' ? raw : raw instanceof Buffer ? raw.toString() : String(raw);
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

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

function readLocalAgentEvent(record: Record<string, unknown>): LocalAgentEvent | null {
  const type = readString(record, 'type');
  const requestId = readString(record, 'requestId');
  if (!type || !requestId) return null;

  if (type === 'message.delta') {
    const role = readString(record, 'role');
    const text = readString(record, 'text');
    return role === 'assistant' && text != null
      ? { type, requestId, role, text }
      : null;
  }
  if (type === 'message.completed') {
    const role = readString(record, 'role');
    const text = readString(record, 'text');
    if (role !== 'assistant' || text == null) return null;
    const metadata = readRecord(record, 'metadata');
    const tags = metadata ? readStringArray(metadata, 'tags') : null;
    return {
      type,
      requestId,
      role,
      text,
      ...(metadata
        ? {
            metadata: {
              mood: readOptionalString(metadata, 'mood') ?? null,
              topic: readOptionalString(metadata, 'topic') ?? null,
              ...(tags ? { tags } : {}),
            },
          }
        : {}),
    };
  }
  if (type === 'operation') {
    const phase = readString(record, 'phase');
    const operation = readRecord(record, 'operation');
    const kind = operation ? readString(operation, 'kind') : null;
    if (!isOperationPhase(phase) || !operation || !kind) return null;
    const source = readRecord(operation, 'source');
    const sourceProvider = source ? readString(source, 'provider') : null;
    const sourceName = source ? readString(source, 'name') : null;
    const raw = readRecord(record, 'raw');
    return {
      type,
      requestId,
      phase,
      operation: {
        id: readOptionalString(operation, 'id'),
        kind,
        title: readOptionalString(operation, 'title'),
        target: readOptionalString(operation, 'target'),
        summary: readOptionalString(operation, 'summary'),
        details: readRecord(operation, 'details') ?? undefined,
        ...(sourceProvider && isOperationSourceProvider(sourceProvider) && sourceName
          ? {
              source: {
                provider: sourceProvider,
                name: sourceName,
                callId: source ? readOptionalString(source, 'callId') : undefined,
              },
            }
          : {}),
      },
      ...(raw ? { raw } : {}),
    };
  }
  if (type === 'human_review.requested') {
    const prompt = readString(record, 'prompt');
    const payload = readRecord(record, 'payload');
    const actor = readRecord(record, 'actor');
    if (prompt == null || !payload) return null;
    return {
      type,
      requestId,
      prompt,
      payload,
      ...(actor ? { actor: { petId: readOptionalString(actor, 'petId') } } : {}),
    };
  }
  if (type === 'studio.progress') {
    const event = readRecord(record, 'event');
    return event ? { type, requestId, event } : null;
  }
  if (type === 'system.notice' || type === 'error') {
    const message = readString(record, 'message');
    return message == null ? null : { type, requestId, message };
  }
  return null;
}

export function parseLocalAgentClientMessage(raw: unknown): LocalAgentClientMessage | null {
  const record = readJsonRecord(raw);
  if (!record) return null;
  const type = readString(record, 'type');
  if (type === 'ping') return { type: 'ping' };
  if (type === 'chat_request') {
    const requestId = readString(record, 'requestId');
    const message = readString(record, 'message');
    if (!requestId || message == null) return null;
    return {
      type,
      requestId,
      message,
      petId: readOptionalString(record, 'petId'),
      userId: readOptionalString(record, 'userId'),
      ...(record.resume !== undefined ? { resume: record.resume } : {}),
    };
  }
  if (type === 'human_review_response') {
    const requestId = readString(record, 'requestId');
    const message = readString(record, 'message');
    if (!requestId || message == null) return null;
    return {
      type,
      requestId,
      message,
      ...(record.resume !== undefined ? { resume: record.resume } : {}),
    };
  }
  if (type === 'interrupt_request') {
    const requestId = readString(record, 'requestId');
    return requestId ? { type, requestId } : null;
  }
  if (type === 'new_session') {
    return {
      type,
      petId: readOptionalString(record, 'petId'),
      userId: readOptionalString(record, 'userId'),
    };
  }
  if (type === 'studio_request') {
    const requestId = readString(record, 'requestId');
    const userRequest = readString(record, 'userRequest');
    if (!requestId || userRequest == null) return null;
    return {
      type,
      requestId,
      userRequest,
      conversationId: readOptionalString(record, 'conversationId'),
    };
  }
  return null;
}

export function parseLocalAgentServerMessage(raw: unknown): LocalAgentServerMessage | null {
  const record = readJsonRecord(raw);
  if (!record) return null;
  const type = readString(record, 'type');
  if (type === 'pong') return { type };
  const requestId = readString(record, 'requestId');
  if (!requestId) return null;
  if (type === 'event') {
    const eventRecord = readRecord(record, 'event');
    const event = eventRecord ? readLocalAgentEvent(eventRecord) : null;
    return event && event.requestId === requestId ? { type, requestId, event } : null;
  }
  if (type === 'chat_token') {
    const token = readString(record, 'token');
    return token == null ? null : { type, requestId, token };
  }
  if (type === 'tool_log') {
    const phase = readString(record, 'phase');
    const toolName = readString(record, 'toolName');
    if (!phase || !isToolLogPhase(phase) || !toolName) return null;
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
  if (type === 'interrupting' || type === 'interrupted' || type === 'studio_error' || type === 'error') {
    return {
      type,
      requestId,
      message: readOptionalString(record, 'message') ?? (type.endsWith('error') ? '' : undefined),
    } as LocalAgentServerMessage;
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
  if (type === 'studio_response') {
    const outcome = readString(record, 'outcome');
    const reply = readString(record, 'reply');
    if ((outcome !== 'done' && outcome !== 'stopped') || reply == null) return null;
    return {
      type,
      requestId,
      outcome,
      reply,
      finalDispatchId: readOptionalString(record, 'finalDispatchId'),
      reason: readOptionalString(record, 'reason'),
    };
  }
  return null;
}

export function sendLocalAgentMessage(ws: WsLike, message: LocalAgentServerMessage | LocalAgentClientMessage) {
  if (ws.readyState !== WS_OPEN) {
    return false;
  }
  if (isLegacyServerMessage(message)) {
    ws.send(JSON.stringify({
      type: 'event',
      requestId: message.requestId,
      event: buildLocalAgentEventFromLegacyMessage(message),
    } satisfies LocalAgentEventMessage));
  }
  ws.send(JSON.stringify(message));
  return true;
}

export function sendLocalAgentEvent(
  ws: WsLike,
  event: LocalAgentEvent,
  options: SendLocalAgentEventOptions = {},
) {
  if (ws.readyState !== WS_OPEN) {
    return false;
  }
  ws.send(JSON.stringify({
    type: 'event',
    requestId: event.requestId,
    event,
  } satisfies LocalAgentEventMessage));
  if (options.legacyCompatibility) {
    const legacyMessage = buildLegacyServerMessageFromLocalAgentEvent(event);
    if (legacyMessage) {
      ws.send(JSON.stringify(legacyMessage));
    }
  }
  return true;
}

function isLegacyServerMessage(message: LocalAgentServerMessage | LocalAgentClientMessage): message is LegacyServerMessage {
  return message.type === 'chat_token'
    || message.type === 'human_interrupt'
    || message.type === 'system_notice'
    || message.type === 'chat_response'
    || message.type === 'studio_turn_event'
    || message.type === 'error';
}

function isToolLogPhase(value: string): value is LegacyToolLogPhase {
  return value === 'start'
    || value === 'end'
    || value === 'complete'
    || value === 'error'
    || value === 'event'
    || value === 'interrupt';
}

function isOperationPhase(value: string | null): value is LocalAgentOperationPhase {
  return value === 'started'
    || value === 'updated'
    || value === 'completed'
    || value === 'failed'
    || value === 'interrupted';
}

function isOperationSourceProvider(value: string): value is 'toolkit' | 'capability' | 'runtime' {
  return value === 'toolkit' || value === 'capability' || value === 'runtime';
}
