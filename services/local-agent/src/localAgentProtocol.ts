import {
  GLOBAL_REVIEW_POLICY_MODE,
  parseTokenUsageSnapshot,
  isReviewSpecValue,
  type BuiltinGlobalReviewPolicyMode,
  type ReviewResponse,
  type ReviewSpec,
} from '@pinpawo/pet-agent';
import type {
  LocalAgentErrorCode,
  LocalAgentOperationPhase,
  LocalAgentOperationRaw,
  LocalAgentRuntimeEvent,
} from './events/localAgentRuntimeEvent';
import type {
  LocalAgentSessionSnapshot,
  LocalAgentSessionSummary,
} from './localAgentSession';
import {
  parseLocalAgentSessionSnapshot,
  parseLocalAgentSessionSummary,
} from './localAgentSessionParser';

export type ChatRequestMessage = {
  type: 'chat_request';
  requestId: string;
  message: string;
  petId?: string;
  userId?: string;
};

export type RunInterruptMessage = {
  type: 'run.interrupt';
  requestId: string;
};

export type ReviewCancelMessage = {
  type: 'review.cancel';
  requestId: string;
  actionId: string;
};

export type NewSessionMessage = {
  type: 'new_session';
  petId?: string;
  userId?: string;
};

export type RuntimeConfigUpdateMessage = {
  type: 'runtime_config.update';
  globalReviewPolicyMode: BuiltinGlobalReviewPolicyMode;
};

export type StudioRequestMessage = {
  type: 'studio_request';
  requestId: string;
  userRequest: string;
  /** 可选:显式覆盖 runId，供外部调度器维持同一次 Studio 运行的幂等主键 */
  runId?: string;
  /** 可选:overrides 默认的 conversation 命名,影响 wiki 子目录 */
  conversationId?: string;
};

export type HumanReviewResponseMessage = {
  type: 'human_review_response';
  requestId: string;
  actionId?: string;
  reviewId: string;
  selectedOptionId: string;
  input?: Record<string, unknown>;
  decisions?: ReviewResponse[];
};

export type SessionSnapshotGetMessage = {
  type: 'session.snapshot.get';
  requestId: string;
};

export type SessionListMessage = {
  type: 'session.list';
  requestId: string;
};

export type SessionResumeMessage = {
  type: 'session.resume';
  requestId: string;
  sessionId: string;
};

export type LocalAgentClientMessage =
  | ChatRequestMessage
  | RunInterruptMessage
  | ReviewCancelMessage
  | NewSessionMessage
  | RuntimeConfigUpdateMessage
  | StudioRequestMessage
  | HumanReviewResponseMessage
  | SessionSnapshotGetMessage
  | SessionListMessage
  | SessionResumeMessage
  | { type: 'ping' };

export type LocalAgentRuntimeEventEnvelope = {
  type: 'event';
  requestId: string;
  event: LocalAgentRuntimeEvent;
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
      finalPetRunId?: string;
      reason?: string;
      workdir?: string;
      runId?: string;
      conversationId?: string;
      idempotencyKey?: string;
    }
  | { type: 'studio_error'; requestId: string; message: string };

export type LocalAgentSessionServerMessage =
  | {
      type: 'session.snapshot.result';
      requestId: string;
      snapshot: LocalAgentSessionSnapshot;
    }
  | {
      type: 'session.list.result';
      requestId: string;
      sessions: LocalAgentSessionSummary[];
    }
  | {
      type: 'session.resume.result';
      requestId: string;
      session: LocalAgentSessionSummary;
      snapshot: LocalAgentSessionSnapshot;
    }
  | {
      type: 'session.error';
      requestId: string;
      operation: 'snapshot' | 'list' | 'resume';
      message: string;
    };

export type LocalAgentServerMessage =
  | LocalAgentRuntimeEventEnvelope
  | LocalAgentControlServerMessage
  | LocalAgentSessionServerMessage;

export type LocalAgentClientMessageEnvelope = {
  type?: string;
  requestId?: string;
};

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

function readRecord(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasOnlyKeys(record: Record<string, unknown>, allowedKeys: readonly string[]) {
  const allowed = new Set(allowedKeys);
  return Object.keys(record).every((key) => allowed.has(key));
}

function readReviewSpec(record: Record<string, unknown>, key: string): ReviewSpec | null {
  const review = readRecord(record, key);
  return isReviewSpecValue(review) ? review : null;
}

function readReviewSpecs(record: Record<string, unknown>, key: string): ReviewSpec[] | null {
  const value = record[key];
  if (value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const reviews = value.filter(isReviewSpecValue);
  return reviews.length === value.length && reviews.length > 0 ? reviews : null;
}

function readReviewResponse(value: unknown): ReviewResponse | null {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (!record || !hasOnlyKeys(record, ['reviewId', 'selectedOptionId', 'input'])) return null;
  const reviewId = readString(record, 'reviewId');
  const selectedOptionId = readString(record, 'selectedOptionId');
  const input = readRecord(record, 'input');
  if (record.input !== undefined && !input) return null;
  return reviewId && selectedOptionId
    ? {
        reviewId,
        selectedOptionId,
        ...(input ? { input } : {}),
      }
    : null;
}

function readReviewResponses(record: Record<string, unknown>, key: string): ReviewResponse[] | null {
  const value = record[key];
  if (value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const responses = value.map(readReviewResponse);
  if (responses.some((response) => !response) || responses.length === 0) return null;
  return responses as ReviewResponse[];
}

function readBuiltinGlobalReviewPolicyMode(
  record: Record<string, unknown>,
  key: string,
): BuiltinGlobalReviewPolicyMode | null {
  const value = readString(record, key);
  if (
    value === GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION
    || value === GLOBAL_REVIEW_POLICY_MODE.AUTO_AUTHORIZATION
    || value === GLOBAL_REVIEW_POLICY_MODE.FULL_ACCESS
  ) {
    return value;
  }
  return null;
}

export function readLocalAgentClientMessageEnvelope(raw: unknown): LocalAgentClientMessageEnvelope | null {
  const record = readJsonRecord(raw);
  if (!record) {
    return null;
  }
  return {
    type: readOptionalString(record, 'type'),
    requestId: readOptionalString(record, 'requestId'),
  };
}

function readRawOperationPayload(
  record: Record<string, unknown>,
): LocalAgentOperationRaw | null {
  const raw = readRecord(record, 'raw');
  if (!raw) return null;
  const result: LocalAgentOperationRaw = {};
  if ('input' in raw) result.input = raw.input;
  if ('output' in raw) result.output = raw.output;
  if ('error' in raw) result.error = raw.error;
  return Object.keys(result).length > 0 ? result : null;
}

function readLocalAgentEvent(record: Record<string, unknown>): LocalAgentRuntimeEvent | null {
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
  if (type === 'subagent.message.delta') {
    const text = readString(record, 'text');
    return text != null ? { type, requestId, text } : null;
  }
  if (type === 'message.completed') {
    const role = readString(record, 'role');
    const text = readString(record, 'text');
    if (role !== 'assistant' || text == null) return null;
    const usage = parseTokenUsageSnapshot(record.usage);
    return {
      type,
      requestId,
      ...(usage ? { usage } : {}),
      role,
      text,
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
    const raw = readRawOperationPayload(record);
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
      ...(raw ? { raw } : {}),
    };
  }
  if (type === 'human_review.requested') {
    if (!hasOnlyKeys(record, ['type', 'requestId', 'interruptId', 'review', 'reviews', 'actor'])) return null;
    const review = readReviewSpec(record, 'review');
    const reviews = readReviewSpecs(record, 'reviews');
    const actor = readRecord(record, 'actor');
    if (!review) return null;
    if (actor && !hasOnlyKeys(actor, ['petId'])) return null;
    return {
      type,
      requestId,
      ...(readOptionalString(record, 'interruptId') ? { interruptId: readOptionalString(record, 'interruptId') } : {}),
      review,
      ...(reviews ? { reviews } : {}),
      ...(actor ? { actor: { petId: readOptionalString(actor, 'petId') } } : {}),
    };
  }
  if (type === 'studio.progress') {
    const event = readRecord(record, 'event');
    return event ? { type, requestId, event } : null;
  }
  if (type === 'system.notice' || type === 'error') {
    const message = readString(record, 'message');
    const code = type === 'error' ? readLocalAgentErrorCode(record) : null;
    return message == null
      ? null
      : {
          type,
          requestId,
          message,
          ...(code ? { code } : {}),
        };
  }
  return null;
}

function readLocalAgentErrorCode(record: Record<string, unknown>): LocalAgentErrorCode | null {
  const code = readOptionalString(record, 'code');
  if (
    code === 'review_closed'
    || code === 'review_stale'
    || code === 'review_wrong_session'
  ) {
    return code;
  }
  return null;
}

export function parseLocalAgentClientMessage(raw: unknown): LocalAgentClientMessage | null {
  const record = readJsonRecord(raw);
  if (!record) return null;
  const type = readString(record, 'type');
  if (type === 'ping') return { type: 'ping' };
  if (type === 'session.snapshot.get' || type === 'session.list') {
    if (!hasOnlyKeys(record, ['type', 'requestId'])) return null;
    const requestId = readString(record, 'requestId');
    return requestId ? { type, requestId } : null;
  }
  if (type === 'session.resume') {
    if (!hasOnlyKeys(record, ['type', 'requestId', 'sessionId'])) return null;
    const requestId = readString(record, 'requestId');
    const sessionId = readString(record, 'sessionId');
    return requestId && sessionId ? { type, requestId, sessionId } : null;
  }
  if (type === 'chat_request') {
    if (!hasOnlyKeys(record, ['type', 'requestId', 'message', 'petId', 'userId'])) return null;
    const requestId = readString(record, 'requestId');
    const message = readString(record, 'message');
    if (!requestId || message == null) return null;
    return {
      type,
      requestId,
      message,
      petId: readOptionalString(record, 'petId'),
      userId: readOptionalString(record, 'userId'),
    };
  }
  if (type === 'human_review_response') {
    if (!hasOnlyKeys(record, ['type', 'requestId', 'actionId', 'reviewId', 'selectedOptionId', 'input', 'decisions'])) return null;
    const requestId = readString(record, 'requestId');
    const actionId = readOptionalString(record, 'actionId');
    const reviewId = readOptionalString(record, 'reviewId');
    const selectedOptionId = readOptionalString(record, 'selectedOptionId');
    const input = readRecord(record, 'input');
    const decisions = readReviewResponses(record, 'decisions');
    if (record.input !== undefined && !input) return null;
    if (record.decisions !== undefined && !decisions) return null;
    if (record.actionId !== undefined && !actionId) return null;
    if (!requestId || !reviewId || !selectedOptionId) return null;
    return {
      type,
      requestId,
      ...(actionId ? { actionId } : {}),
      reviewId,
      selectedOptionId,
      ...(input ? { input } : {}),
      ...(decisions ? { decisions } : {}),
    };
  }
  if (type === 'run.interrupt') {
    if (!hasOnlyKeys(record, ['type', 'requestId'])) return null;
    const requestId = readString(record, 'requestId');
    return requestId ? { type, requestId } : null;
  }
  if (type === 'review.cancel') {
    if (!hasOnlyKeys(record, ['type', 'requestId', 'actionId'])) return null;
    const requestId = readString(record, 'requestId');
    const actionId = readString(record, 'actionId');
    return requestId && actionId ? { type, requestId, actionId } : null;
  }
  // Compatibility boundary for clients predating the split control messages.
  // Normalize immediately so downstream code never infers intent from actionId?.
  if (type === 'interrupt_request') {
    if (!hasOnlyKeys(record, ['type', 'requestId', 'actionId'])) return null;
    const requestId = readString(record, 'requestId');
    const actionId = readOptionalString(record, 'actionId');
    if (record.actionId !== undefined && !actionId) return null;
    if (!requestId) return null;
    return actionId
      ? { type: 'review.cancel', requestId, actionId }
      : { type: 'run.interrupt', requestId };
  }
  if (type === 'new_session') {
    return {
      type,
      petId: readOptionalString(record, 'petId'),
      userId: readOptionalString(record, 'userId'),
    };
  }
  if (type === 'runtime_config.update') {
    if (!hasOnlyKeys(record, ['type', 'globalReviewPolicyMode'])) return null;
    const globalReviewPolicyMode = readBuiltinGlobalReviewPolicyMode(record, 'globalReviewPolicyMode');
    return globalReviewPolicyMode ? { type, globalReviewPolicyMode } : null;
  }
  if (type === 'studio_request') {
    const requestId = readString(record, 'requestId');
    const userRequest = readString(record, 'userRequest');
    if (!requestId || userRequest == null) return null;
    if ('runId' in record && typeof record.runId !== 'string') return null;
    if ('conversationId' in record && typeof record.conversationId !== 'string') return null;
    if (!hasOnlyKeys(record, ['type', 'requestId', 'runId', 'userRequest', 'conversationId'])) {
      return null;
    }
    return {
      type,
      requestId,
      userRequest,
      conversationId: readOptionalString(record, 'conversationId'),
      runId: readOptionalString(record, 'runId'),
    };
  }
  return null;
}

function parseLocalAgentServerRecord(record: Record<string, unknown>): LocalAgentServerMessage | null {
  const type = readString(record, 'type');
  if (type === 'pong') return { type };
  const requestId = readString(record, 'requestId');
  if (!requestId) return null;
  if (type === 'session.snapshot.result') {
    if (!hasOnlyKeys(record, ['type', 'requestId', 'snapshot'])) return null;
    const snapshot = parseLocalAgentSessionSnapshot(record.snapshot);
    return snapshot ? { type, requestId, snapshot } : null;
  }
  if (type === 'session.list.result') {
    if (!hasOnlyKeys(record, ['type', 'requestId', 'sessions'])) return null;
    if (!Array.isArray(record.sessions)) return null;
    const sessions = record.sessions.flatMap((value) => {
      const session = parseLocalAgentSessionSummary(value);
      return session ? [session] : [];
    });
    return sessions.length === record.sessions.length
      ? { type, requestId, sessions }
      : null;
  }
  if (type === 'session.resume.result') {
    if (!hasOnlyKeys(record, ['type', 'requestId', 'session', 'snapshot'])) return null;
    const session = parseLocalAgentSessionSummary(record.session);
    const snapshot = parseLocalAgentSessionSnapshot(record.snapshot);
    if (
      !session
      || !snapshot
      || snapshot.session.sessionId !== session.id
      || snapshot.session.kind !== session.kind
    ) {
      return null;
    }
    return { type, requestId, session, snapshot };
  }
  if (type === 'session.error') {
    if (!hasOnlyKeys(record, ['type', 'requestId', 'operation', 'message'])) return null;
    const operation = readString(record, 'operation');
    const message = readString(record, 'message');
    if (
      (operation !== 'snapshot' && operation !== 'list' && operation !== 'resume')
      || message === null
    ) {
      return null;
    }
    return { type, requestId, operation, message };
  }
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
      finalPetRunId: readOptionalString(record, 'finalPetRunId'),
      reason: readOptionalString(record, 'reason'),
      workdir: readOptionalString(record, 'workdir'),
      runId: readOptionalString(record, 'runId'),
      conversationId: readOptionalString(record, 'conversationId'),
      idempotencyKey: readOptionalString(record, 'idempotencyKey'),
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

export type SendLocalAgentEventOptions = {
  /**
   * When false (default), strips `operation.raw` from operation events before
   * serializing — safe default for transports that may reach an untrusted or
   * bandwidth-sensitive peer (e.g. hosted app WS relay).
   *
   * Pass `true` for trusted local transports (TUI on 127.0.0.1, macOS
   * companion) that need raw input/output to render diffs, expand payloads,
   * or feed local-only debugging surfaces.
   */
  includeRaw?: boolean;
};

export function buildLocalAgentEventEnvelope(
  event: LocalAgentRuntimeEvent,
  options: SendLocalAgentEventOptions = {},
): LocalAgentRuntimeEventEnvelope {
  const wireEvent = options.includeRaw ? event : sanitizeLocalAgentRemoteEvent(event);
  return {
    type: 'event',
    requestId: wireEvent.requestId,
    event: wireEvent,
  };
}

export function sendLocalAgentEvent(
  ws: WsLike,
  event: LocalAgentRuntimeEvent,
  options: SendLocalAgentEventOptions = {},
) {
  if (ws.readyState !== WS_OPEN) {
    return false;
  }
  ws.send(JSON.stringify(buildLocalAgentEventEnvelope(event, options)));
  return true;
}

export function sanitizeLocalAgentRemoteEvent(
  event: LocalAgentRuntimeEvent,
): LocalAgentRuntimeEvent {
  if (event.type !== 'operation' || event.raw === undefined) {
    return event;
  }
  const { raw: _raw, ...rest } = event;
  return rest;
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
