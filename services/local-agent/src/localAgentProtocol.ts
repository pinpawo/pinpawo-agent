import type { ReviewSpec } from '@pinpawo/pet-agent';
import type {
  LocalAgentEvent,
  LocalAgentOperationInternalEvent,
  LocalAgentOperationPhase,
} from './events/localAgentEvent';

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
  reviewId: string;
  selectedOptionId: string;
  input?: Record<string, unknown>;
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
  | LocalAgentControlServerMessage;

type WsLike = {
  readyState: number;
  send(data: string): unknown;
};

const WS_OPEN = 1;

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

function readOptionalNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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

function readReviewSpec(record: Record<string, unknown>, key: string): ReviewSpec | null {
  const review = readRecord(record, key);
  if (!review) return null;
  const id = readString(review, 'id');
  const schemaVersion = readOptionalNumber(review, 'schemaVersion');
  const view = readRecord(review, 'view');
  const viewKind = view ? readString(view, 'kind') : null;
  const viewBody = view ? readString(view, 'body') : null;
  const options = review.options;
  if (
    !id
    || schemaVersion === undefined
    || (viewKind !== 'plain' && viewKind !== 'markdown')
    || viewBody == null
    || !Array.isArray(options)
  ) {
    return null;
  }

  const validOptions = options.every((option) => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) return false;
    const optionRecord = option as Record<string, unknown>;
    return typeof optionRecord.id === 'string'
      && typeof optionRecord.label === 'string'
      && optionRecord.decision
      && typeof optionRecord.decision === 'object'
      && !Array.isArray(optionRecord.decision);
  });
  return validOptions ? review as ReviewSpec : null;
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
    const usageRecord = readRecord(record, 'usage');
    const inputTokens = usageRecord ? readOptionalNumber(usageRecord, 'inputTokens') : undefined;
    const outputTokens = usageRecord ? readOptionalNumber(usageRecord, 'outputTokens') : undefined;
    const totalTokens = usageRecord ? readOptionalNumber(usageRecord, 'totalTokens') : undefined;
    const contextWindow = usageRecord ? readOptionalNumber(usageRecord, 'contextWindow') : undefined;
    const updatedAt = usageRecord ? readOptionalString(usageRecord, 'updatedAt') : undefined;
    const usage = inputTokens !== undefined
      && outputTokens !== undefined
      && totalTokens !== undefined
      ? {
          inputTokens,
          outputTokens,
          totalTokens,
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(updatedAt !== undefined ? { updatedAt } : {}),
        }
      : undefined;
    return {
      type,
      requestId,
      ...(usage ? { usage } : {}),
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
    const normalizedProvider = normalizeOperationSourceProvider(sourceProvider);
    const sourceToolName = source ? readOptionalString(source, 'toolName') : undefined;
    const sourceCallId = source ? readOptionalString(source, 'callId') : undefined;
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
        ...(normalizedProvider && sourceName
          ? {
              source: {
                provider: normalizedProvider,
                name: sourceName,
                ...(sourceToolName ? { toolName: sourceToolName } : {}),
                ...(sourceCallId ? { callId: sourceCallId } : {}),
              },
            }
          : {}),
      },
    };
  }
  if (type === 'human_review.requested') {
    const prompt = readOptionalString(record, 'prompt');
    const payload = readRecord(record, 'payload');
    const review = readReviewSpec(record, 'review');
    const actor = readRecord(record, 'actor');
    if (!review) return null;
    return {
      type,
      requestId,
      review,
      ...(prompt != null ? { prompt } : {}),
      ...(payload ? { payload } : {}),
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
    const reviewId = readOptionalString(record, 'reviewId');
    const selectedOptionId = readOptionalString(record, 'selectedOptionId');
    const input = readRecord(record, 'input');
    if (!requestId || !reviewId || !selectedOptionId) return null;
    return {
      type,
      requestId,
      message: message ?? '',
      reviewId,
      selectedOptionId,
      ...(input ? { input } : {}),
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

function parseLocalAgentServerRecord(record: Record<string, unknown>): LocalAgentServerMessage | null {
  const type = readString(record, 'type');
  if (type === 'pong') return { type };
  const requestId = readString(record, 'requestId');
  if (!requestId) return null;
  if (type === 'event') {
    const eventRecord = readRecord(record, 'event');
    const event = eventRecord ? readLocalAgentEvent(eventRecord) : null;
    return event && event.requestId === requestId ? { type, requestId, event } : null;
  }
  if (type === 'interrupting' || type === 'interrupted' || type === 'studio_error') {
    return {
      type,
      requestId,
      message: readOptionalString(record, 'message') ?? (type === 'studio_error' ? '' : undefined),
    } as LocalAgentServerMessage;
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

export function parseLocalAgentServerMessage(raw: unknown): LocalAgentServerMessage | null {
  const record = readJsonRecord(raw);
  if (!record) return null;
  return parseLocalAgentServerRecord(record);
}

export function sendLocalAgentMessage(
  ws: WsLike,
  message: LocalAgentServerMessage | LocalAgentClientMessage,
) {
  if (ws.readyState !== WS_OPEN) {
    return false;
  }
  ws.send(JSON.stringify(message));
  return true;
}

export function sendLocalAgentEvent(ws: WsLike, event: LocalAgentEvent) {
  if (ws.readyState !== WS_OPEN) {
    return false;
  }
  const publicEvent = toPublicLocalAgentEvent(event);
  ws.send(JSON.stringify({
    type: 'event',
    requestId: publicEvent.requestId,
    event: publicEvent,
  } satisfies LocalAgentEventMessage));
  return true;
}

function toPublicLocalAgentEvent(event: LocalAgentEvent): LocalAgentEvent {
  if (event.type !== 'operation') {
    return event;
  }
  const { raw: _raw, ...publicEvent } = event as LocalAgentOperationInternalEvent;
  return publicEvent;
}

function isOperationPhase(value: string | null): value is LocalAgentOperationPhase {
  return value === 'started'
    || value === 'updated'
    || value === 'completed'
    || value === 'failed'
    || value === 'interrupted';
}

function normalizeOperationSourceProvider(value: string | null): 'toolkit' | 'toolset' | 'runtime' | null {
  if (value === 'toolkit' || value === 'toolset' || value === 'runtime') return value;
  if (value === 'capability') return 'toolset';
  return null;
}
