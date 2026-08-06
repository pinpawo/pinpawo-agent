import type {
  JsonObject as ContractJsonObject,
  ToolAuthorizationMode,
} from '@pinpawo/agent-contracts';
import type {
  ReviewResponse,
  ReviewSpec,
} from './review';
import type {
  AgentErrorCode,
  AgentOperationRaw,
  AgentOperationPhase,
  AgentRuntimeEvent,
} from './events';
import type {
  AgentInputModality,
  AgentModelProfileSummary,
  AgentSessionSummary,
} from './domain';
import type {
  AgentSessionSnapshot,
  JsonObject,
} from './snapshot';
import { isJsonValue } from './snapshot';
import {
  parseAgentSessionSnapshot,
  parseAgentSessionSummary,
} from './parser';
import {
  isAgentReviewSpecValue,
  isBuiltinGlobalReviewPolicyMode,
  parseAgentPlan,
  parseAgentTokenUsageSnapshot,
} from './validation';
import {
  AGENT_LOCAL_ATTACHMENT_LIMIT,
  type AgentLocalAttachment,
} from './localAttachments';

/**
 * Deprecated wire compatibility only. Runtime delegation transitions are not
 * part of agent-contracts and new callers must not emit this field.
 */
type LegacyActiveDelegationTransition = 'supersede_active' | 'resume_active';

export type ChatRequestMessage = {
  type: 'chat_request';
  requestId: string;
  message: string;
  attachments?: AgentLocalAttachment[];
  petId?: string;
  userId?: string;
  activeDelegationTransition?: LegacyActiveDelegationTransition;
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
  /** Optional for compatibility with pre-acknowledgement local clients. */
  requestId?: string;
  globalReviewPolicyMode: ToolAuthorizationMode;
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

type HumanReviewResponseMessageBase = {
  type: 'human_review_response';
  requestId: string;
  actionId?: string;
  selectedOptionId: string;
  input?: Record<string, unknown>;
  decisions?: (ReviewResponse | LegacyHumanReviewResponse)[];
};

/**
 * A public interaction response. `reviewId` is accepted only as a legacy wire
 * alias and never appears in agent-contracts.
 */
export type HumanReviewResponseMessage = HumanReviewResponseMessageBase & (
  | { interactionId: string; reviewId?: string }
  | { /** @deprecated Pre-contract wire compatibility only. */ interactionId?: undefined; reviewId: string }
);

/** @deprecated Accepted only to preserve pre-contract wire compatibility. */
export type LegacyHumanReviewResponse = {
  reviewId: string;
  selectedOptionId: string;
  input?: Record<string, unknown>;
};

export type SessionSnapshotGetMessage = {
  type: 'session.snapshot.get';
  requestId: string;
};

export type SessionListMessage = {
  type: 'session.list';
  requestId: string;
};

export type SessionNewMessage = {
  type: 'session.new';
  requestId: string;
};

export type SessionResumeMessage = {
  type: 'session.resume';
  requestId: string;
  sessionId: string;
};

export type ModelListMessage = {
  type: 'model.list';
  requestId: string;
  sessionId: string;
};

export type ModelSelectMessage = {
  type: 'model.select';
  requestId: string;
  sessionId: string;
  modelProfileId: string;
};

export type AgentClientMessage =
  | ChatRequestMessage
  | RunInterruptMessage
  | ReviewCancelMessage
  | NewSessionMessage
  | RuntimeConfigUpdateMessage
  | StudioRequestMessage
  | HumanReviewResponseMessage
  | SessionSnapshotGetMessage
  | SessionListMessage
  | SessionNewMessage
  | SessionResumeMessage
  | ModelListMessage
  | ModelSelectMessage
  | { type: 'ping' };

export type AgentRuntimeEventEnvelope = {
  type: 'event';
  requestId: string;
  event: AgentRuntimeEvent;
};

export type AgentControlServerMessage =
  | { type: 'pong' }
  | {
      type: 'runtime_config.result';
      requestId: string;
      globalReviewPolicyMode: ToolAuthorizationMode;
    }
  | {
      type: 'runtime_config.error';
      requestId: string;
      message: string;
    }
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

export type AgentSessionServerMessage =
  | {
      type: 'session.snapshot.result';
      requestId: string;
      snapshot: AgentSessionSnapshot;
    }
  | {
      type: 'session.list.result';
      requestId: string;
      sessions: AgentSessionSummary[];
    }
  | {
      type: 'session.new.result';
      requestId: string;
      session: AgentSessionSummary;
      snapshot: AgentSessionSnapshot;
    }
  | {
      type: 'session.resume.result';
      requestId: string;
      session: AgentSessionSummary;
      snapshot: AgentSessionSnapshot;
    }
  | {
      type: 'session.error';
      requestId: string;
      operation: 'snapshot' | 'list' | 'new' | 'resume';
      message: string;
    };

export type AgentModelServerMessage =
  | {
      type: 'model.list.result';
      requestId: string;
      sessionId: string;
      defaultProfileId: string;
      selectedProfileId: string;
      requiredInputModalities: AgentInputModality[];
      profiles: AgentModelProfileSummary[];
    }
  | {
      type: 'model.select.result';
      requestId: string;
      sessionId: string;
      selectedProfileId: string;
      snapshot: AgentSessionSnapshot;
    }
  | {
      type: 'model.select.error';
      requestId: string;
      sessionId: string;
      modelProfileId?: string;
      code:
        | 'session_not_found'
        | 'session_not_active'
        | 'run_active'
        | 'review_pending'
        | 'profile_unavailable'
        | 'profile_incompatible'
        | 'selection_failed';
      message: string;
    };

export type AgentServerMessage =
  | AgentRuntimeEventEnvelope
  | AgentControlServerMessage
  | AgentSessionServerMessage
  | AgentModelServerMessage;

export type AgentClientMessageEnvelope = {
  type?: string;
  requestId?: string;
};

function readJsonRecord(raw: unknown): Record<string, unknown> | null {
  try {
    const parsed = typeof raw === 'string'
      ? JSON.parse(raw) as unknown
      : raw;
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

function readActiveDelegationTransition(
  record: Record<string, unknown>,
): LegacyActiveDelegationTransition | null | undefined {
  const value = record.activeDelegationTransition;
  if (value === undefined) return undefined;
  return value === 'supersede_active' || value === 'resume_active'
    ? value
    : null;
}

function readOptionalStringArray(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value === undefined) return undefined;
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value as string[]
    : null;
}

function readInputModalities(value: unknown): AgentInputModality[] | null {
  if (
    !Array.isArray(value)
    || value.length === 0
    || !value.every((item) => item === 'text' || item === 'image')
  ) {
    return null;
  }
  return [...new Set(value)] as AgentInputModality[];
}

function readModelProfileSummaries(
  value: unknown,
): AgentModelProfileSummary[] | null {
  if (!Array.isArray(value)) return null;
  const profiles: AgentModelProfileSummary[] = [];
  const profileIds = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const profile = item as Record<string, unknown>;
    if (!hasOnlyKeys(profile, [
      'id',
      'label',
      'provider',
      'model',
      'endpointHost',
      'contextWindowTokens',
      'inputModalities',
      'available',
      'compatible',
      'issues',
    ])) {
      return null;
    }
    const id = typeof profile.id === 'string' ? profile.id : '';
    const label = typeof profile.label === 'string' ? profile.label : '';
    const inputModalities = readInputModalities(profile.inputModalities);
    const available = profile.available;
    const compatible = profile.compatible;
    const issues = profile.issues;
    if (
      !id
      || !label
      || !inputModalities
      || typeof available !== 'boolean'
      || typeof compatible !== 'boolean'
      || !Array.isArray(issues)
      || !issues.every((issue) => typeof issue === 'string')
    ) {
      return null;
    }
    if (profileIds.has(id)) return null;
    profileIds.add(id);
    const contextWindowTokens = profile.contextWindowTokens;
    if (
      contextWindowTokens !== undefined
      && (
        typeof contextWindowTokens !== 'number'
        || !Number.isSafeInteger(contextWindowTokens)
        || contextWindowTokens <= 0
      )
    ) {
      return null;
    }
    for (const field of ['provider', 'model', 'endpointHost'] as const) {
      if (profile[field] !== undefined && typeof profile[field] !== 'string') {
        return null;
      }
    }
    profiles.push({
      id,
      label,
      ...(typeof profile.provider === 'string'
        ? { provider: profile.provider }
        : {}),
      ...(typeof profile.model === 'string' ? { model: profile.model } : {}),
      ...(typeof profile.endpointHost === 'string'
        ? { endpointHost: profile.endpointHost }
        : {}),
      ...(typeof contextWindowTokens === 'number'
        ? { contextWindowTokens }
        : {}),
      inputModalities,
      available,
      compatible,
      issues: [...issues],
    });
  }
  return profiles;
}

function readRecord(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readLocalAttachments(
  record: Record<string, unknown>,
  key: string,
): AgentLocalAttachment[] | null | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > AGENT_LOCAL_ATTACHMENT_LIMIT
  ) {
    return null;
  }
  const attachments: AgentLocalAttachment[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const candidate of value) {
    const attachment = readLocalAttachment(candidate);
    if (
      !attachment
      || ids.has(attachment.id)
      || paths.has(attachment.path)
    ) {
      return null;
    }
    ids.add(attachment.id);
    paths.add(attachment.path);
    attachments.push(attachment);
  }
  return attachments;
}

function readLocalAttachment(value: unknown): AgentLocalAttachment | null {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (!record || !hasOnlyKeys(record, ['id', 'source', 'kind', 'path', 'name'])) {
    return null;
  }
  const id = readString(record, 'id');
  const source = readString(record, 'source');
  const kind = readString(record, 'kind');
  const path = readString(record, 'path');
  const name = readString(record, 'name');
  if (
    !id
    || id.length > 200
    || source !== 'local-path'
    || (kind !== 'file' && kind !== 'directory')
    || !path
    || path.length > 4_096
    || path.includes('\0')
    || !isAbsoluteLocalPath(path)
    || !name
    || name.length > 255
    || name.includes('\0')
  ) {
    return null;
  }
  return { id, source, kind, path, name };
}

function isAbsoluteLocalPath(path: string) {
  return path.startsWith('/')
    || path.startsWith('\\\\')
    || /^[A-Za-z]:[\\/]/.test(path);
}

function hasOnlyKeys(record: Record<string, unknown>, allowedKeys: readonly string[]) {
  const allowed = new Set(allowedKeys);
  return Object.keys(record).every((key) => allowed.has(key));
}

function readReviewSpec(record: Record<string, unknown>, key: string): ReviewSpec | null {
  const review = readRecord(record, key);
  return isAgentReviewSpecValue(review) ? review : null;
}

function readReviewSpecs(record: Record<string, unknown>, key: string): ReviewSpec[] | null {
  const value = record[key];
  if (value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const reviews = value.filter(isAgentReviewSpecValue);
  return reviews.length === value.length && reviews.length > 0 ? reviews : null;
}

function readReviewResponse(value: unknown): ReviewResponse | null {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (!record || !hasOnlyKeys(record, ['interactionId', 'reviewId', 'selectedOptionId', 'input'])) return null;
  const interactionId = readOptionalString(record, 'interactionId') ?? readString(record, 'reviewId');
  const selectedOptionId = readString(record, 'selectedOptionId');
  const input = readRecord(record, 'input');
  if (record.input !== undefined && (!input || !isJsonValue(input))) return null;
  return interactionId && selectedOptionId
    ? {
        interactionId,
        selectedOptionId,
        ...(input ? { input: input as ContractJsonObject } : {}),
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
): ToolAuthorizationMode | null {
  const value = readString(record, key);
  return isBuiltinGlobalReviewPolicyMode(value) ? value : null;
}

export function readAgentClientMessageEnvelope(raw: unknown): AgentClientMessageEnvelope | null {
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
): AgentOperationRaw | null {
  const raw = readRecord(record, 'raw');
  if (!raw) return null;
  const result: AgentOperationRaw = {};
  if ('input' in raw) {
    if (!isJsonValue(raw.input)) return null;
    result.input = raw.input;
  }
  if ('output' in raw) {
    if (!isJsonValue(raw.output)) return null;
    result.output = raw.output;
  }
  if ('error' in raw) {
    if (!isJsonValue(raw.error)) return null;
    result.error = raw.error;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function readAgentEvent(record: Record<string, unknown>): AgentRuntimeEvent | null {
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
  if (type === 'subagent.message.completed') {
    const text = readString(record, 'text');
    const namespace = readOptionalStringArray(record, 'namespace');
    const messageId = readString(record, 'messageId');
    if (text == null || !messageId || !namespace) return null;
    return {
      type,
      requestId,
      messageId,
      namespace,
      text,
    };
  }
  if (type === 'message.completed') {
    const role = readString(record, 'role');
    const text = readString(record, 'text');
    if (role !== 'assistant' || text == null) return null;
    const usage = parseAgentTokenUsageSnapshot(record.usage);
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
    const details = readJsonObject(operation, 'details');
    if (operation.details !== undefined && !details) return null;
    return {
      type,
      requestId,
      phase,
      operation: {
        ...(readOptionalString(operation, 'id') !== undefined
          ? { id: readOptionalString(operation, 'id') }
          : {}),
        kind,
        ...(readOptionalString(operation, 'title') !== undefined
          ? { title: readOptionalString(operation, 'title') }
          : {}),
        ...(readOptionalString(operation, 'target') !== undefined
          ? { target: readOptionalString(operation, 'target') }
          : {}),
        ...(readOptionalString(operation, 'summary') !== undefined
          ? { summary: readOptionalString(operation, 'summary') }
          : {}),
        ...(details ? { details } : {}),
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
  if (type === 'plan.updated') {
    if (!hasOnlyKeys(record, ['type', 'requestId', 'plan'])) return null;
    const plan = record.plan === null ? null : parseAgentPlan(record.plan);
    return plan === null && record.plan !== null
      ? null
      : { type, requestId, plan };
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
      ...(actor
        ? {
            actor: {
              ...(readOptionalString(actor, 'petId') !== undefined
                ? { petId: readOptionalString(actor, 'petId') }
                : {}),
            },
          }
        : {}),
    };
  }
  if (type === 'studio.progress') {
    const event = readJsonObject(record, 'event');
    return event ? { type, requestId, event } : null;
  }
  if (type === 'system.notice' || type === 'error') {
    const message = readString(record, 'message');
    const code = type === 'error' ? readAgentErrorCode(record) : null;
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

function readJsonObject(
  record: Record<string, unknown>,
  key: string,
): JsonObject | null {
  const value = readRecord(record, key);
  return value && isJsonValue(value) ? value : null;
}

function readAgentErrorCode(record: Record<string, unknown>): AgentErrorCode | null {
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

export function parseAgentClientMessage(raw: unknown): AgentClientMessage | null {
  const record = readJsonRecord(raw);
  if (!record) return null;
  const type = readString(record, 'type');
  if (type === 'ping') return { type: 'ping' };
  if (
    type === 'session.snapshot.get'
    || type === 'session.list'
    || type === 'session.new'
  ) {
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
  if (type === 'model.list') {
    if (!hasOnlyKeys(record, ['type', 'requestId', 'sessionId'])) return null;
    const requestId = readString(record, 'requestId');
    const sessionId = readString(record, 'sessionId');
    return requestId && sessionId ? { type, requestId, sessionId } : null;
  }
  if (type === 'model.select') {
    if (!hasOnlyKeys(record, [
      'type',
      'requestId',
      'sessionId',
      'modelProfileId',
    ])) return null;
    const requestId = readString(record, 'requestId');
    const sessionId = readString(record, 'sessionId');
    const modelProfileId = readString(record, 'modelProfileId');
    return requestId && sessionId && modelProfileId
      ? { type, requestId, sessionId, modelProfileId }
      : null;
  }
  if (type === 'chat_request') {
    if (!hasOnlyKeys(record, [
      'type',
      'requestId',
      'message',
      'attachments',
      'petId',
      'userId',
      'activeDelegationTransition',
    ])) return null;
    const requestId = readString(record, 'requestId');
    const message = readString(record, 'message');
    const attachments = readLocalAttachments(record, 'attachments');
    const activeDelegationTransition = readActiveDelegationTransition(record);
    if (
      !requestId
      || message == null
      || attachments === null
      || activeDelegationTransition === null
    ) return null;
    return {
      type,
      requestId,
      message,
      ...(attachments ? { attachments } : {}),
      ...(readOptionalString(record, 'petId') !== undefined
        ? { petId: readOptionalString(record, 'petId') }
        : {}),
      ...(readOptionalString(record, 'userId') !== undefined
        ? { userId: readOptionalString(record, 'userId') }
        : {}),
      ...(activeDelegationTransition
        ? { activeDelegationTransition }
        : {}),
    };
  }
  if (type === 'human_review_response') {
    if (!hasOnlyKeys(record, ['type', 'requestId', 'actionId', 'interactionId', 'reviewId', 'selectedOptionId', 'input', 'decisions'])) return null;
    const requestId = readString(record, 'requestId');
    const actionId = readOptionalString(record, 'actionId');
    const interactionId = readOptionalString(record, 'interactionId');
    const reviewId = readOptionalString(record, 'reviewId');
    const selectedOptionId = readOptionalString(record, 'selectedOptionId');
    const input = readRecord(record, 'input');
    const decisions = readReviewResponses(record, 'decisions');
    if (record.input !== undefined && !input) return null;
    if (record.decisions !== undefined && !decisions) return null;
    if (record.actionId !== undefined && !actionId) return null;
    if (!requestId || (!interactionId && !reviewId) || !selectedOptionId) return null;
    if (interactionId !== undefined && reviewId !== undefined && interactionId !== reviewId) return null;
    const canonicalInteractionId = interactionId ?? reviewId!;
    return {
      type,
      requestId,
      ...(actionId ? { actionId } : {}),
      interactionId: canonicalInteractionId,
      ...(reviewId ? { reviewId } : {}),
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
  if (type === 'new_session') {
    return {
      type,
      ...(readOptionalString(record, 'petId') !== undefined
        ? { petId: readOptionalString(record, 'petId') }
        : {}),
      ...(readOptionalString(record, 'userId') !== undefined
        ? { userId: readOptionalString(record, 'userId') }
        : {}),
    };
  }
  if (type === 'runtime_config.update') {
    if (!hasOnlyKeys(record, ['type', 'requestId', 'globalReviewPolicyMode'])) return null;
    const requestId = readOptionalString(record, 'requestId');
    if ('requestId' in record && !requestId) return null;
    const globalReviewPolicyMode = readBuiltinGlobalReviewPolicyMode(record, 'globalReviewPolicyMode');
    return globalReviewPolicyMode
      ? {
          type,
          ...(requestId ? { requestId } : {}),
          globalReviewPolicyMode,
        }
      : null;
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
      ...(readOptionalString(record, 'conversationId') !== undefined
        ? { conversationId: readOptionalString(record, 'conversationId') }
        : {}),
      ...(readOptionalString(record, 'runId') !== undefined
        ? { runId: readOptionalString(record, 'runId') }
        : {}),
    };
  }
  return null;
}

function parseAgentServerRecord(record: Record<string, unknown>): AgentServerMessage | null {
  const type = readString(record, 'type');
  if (type === 'pong') return { type };
  const requestId = readString(record, 'requestId');
  if (!requestId) return null;
  if (type === 'session.snapshot.result') {
    if (!hasOnlyKeys(record, ['type', 'requestId', 'snapshot'])) return null;
    const snapshot = parseAgentSessionSnapshot(record.snapshot);
    return snapshot ? { type, requestId, snapshot } : null;
  }
  if (type === 'session.list.result') {
    if (!hasOnlyKeys(record, ['type', 'requestId', 'sessions'])) return null;
    if (!Array.isArray(record.sessions)) return null;
    const sessions = record.sessions.flatMap((value) => {
      const session = parseAgentSessionSummary(value);
      return session ? [session] : [];
    });
    return sessions.length === record.sessions.length
      ? { type, requestId, sessions }
      : null;
  }
  if (type === 'session.new.result' || type === 'session.resume.result') {
    if (!hasOnlyKeys(record, ['type', 'requestId', 'session', 'snapshot'])) return null;
    const session = parseAgentSessionSummary(record.session);
    const snapshot = parseAgentSessionSnapshot(record.snapshot);
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
      (
        operation !== 'snapshot'
        && operation !== 'list'
        && operation !== 'new'
        && operation !== 'resume'
      )
      || message === null
    ) {
      return null;
    }
    return { type, requestId, operation, message };
  }
  if (type === 'model.list.result') {
    if (!hasOnlyKeys(record, [
      'type',
      'requestId',
      'sessionId',
      'defaultProfileId',
      'selectedProfileId',
      'requiredInputModalities',
      'profiles',
    ])) return null;
    const sessionId = readString(record, 'sessionId');
    const defaultProfileId = readString(record, 'defaultProfileId');
    const selectedProfileId = readString(record, 'selectedProfileId');
    const requiredInputModalities = readInputModalities(
      record.requiredInputModalities,
    );
    const profiles = readModelProfileSummaries(record.profiles);
    return sessionId
      && defaultProfileId
      && selectedProfileId
      && requiredInputModalities
      && profiles
      && profiles.some((profile) => profile.id === defaultProfileId)
      && profiles.some((profile) => profile.id === selectedProfileId)
      ? {
          type,
          requestId,
          sessionId,
          defaultProfileId,
          selectedProfileId,
          requiredInputModalities,
          profiles,
        }
      : null;
  }
  if (type === 'model.select.result') {
    if (!hasOnlyKeys(record, [
      'type',
      'requestId',
      'sessionId',
      'selectedProfileId',
      'snapshot',
    ])) return null;
    const sessionId = readString(record, 'sessionId');
    const selectedProfileId = readString(record, 'selectedProfileId');
    const snapshot = parseAgentSessionSnapshot(record.snapshot);
    return sessionId
      && selectedProfileId
      && snapshot?.session.sessionId === sessionId
      && snapshot.session.runtime?.modelProfileId === selectedProfileId
      ? { type, requestId, sessionId, selectedProfileId, snapshot }
      : null;
  }
  if (type === 'model.select.error') {
    if (!hasOnlyKeys(record, [
      'type',
      'requestId',
      'sessionId',
      'modelProfileId',
      'code',
      'message',
    ])) return null;
    const sessionId = readString(record, 'sessionId');
    const modelProfileId = readOptionalString(record, 'modelProfileId');
    const code = readString(record, 'code');
    const message = readString(record, 'message');
    if (
      !sessionId
      || message === null
      || (
        code !== 'session_not_found'
        && code !== 'session_not_active'
        && code !== 'run_active'
        && code !== 'review_pending'
        && code !== 'profile_unavailable'
        && code !== 'profile_incompatible'
        && code !== 'selection_failed'
      )
    ) {
      return null;
    }
    return {
      type,
      requestId,
      sessionId,
      ...(modelProfileId ? { modelProfileId } : {}),
      code,
      message,
    };
  }
  if (type === 'runtime_config.result') {
    if (!hasOnlyKeys(record, ['type', 'requestId', 'globalReviewPolicyMode'])) return null;
    const globalReviewPolicyMode = readBuiltinGlobalReviewPolicyMode(
      record,
      'globalReviewPolicyMode',
    );
    return globalReviewPolicyMode
      ? { type, requestId, globalReviewPolicyMode }
      : null;
  }
  if (type === 'runtime_config.error') {
    if (!hasOnlyKeys(record, ['type', 'requestId', 'message'])) return null;
    const message = readString(record, 'message');
    return message !== null ? { type, requestId, message } : null;
  }
  if (type === 'event') {
    const eventRecord = readRecord(record, 'event');
    const event = eventRecord ? readAgentEvent(eventRecord) : null;
    return event && event.requestId === requestId ? { type, requestId, event } : null;
  }
  if (type === 'interrupting' || type === 'interrupted' || type === 'studio_error') {
    const message = readOptionalString(record, 'message')
      ?? (type === 'studio_error' ? '' : undefined);
    return {
      type,
      requestId,
      ...(message !== undefined ? { message } : {}),
    } as AgentServerMessage;
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
      ...(readOptionalString(record, 'finalPetRunId') !== undefined
        ? { finalPetRunId: readOptionalString(record, 'finalPetRunId') }
        : {}),
      ...(readOptionalString(record, 'reason') !== undefined
        ? { reason: readOptionalString(record, 'reason') }
        : {}),
      ...(readOptionalString(record, 'workdir') !== undefined
        ? { workdir: readOptionalString(record, 'workdir') }
        : {}),
      ...(readOptionalString(record, 'runId') !== undefined
        ? { runId: readOptionalString(record, 'runId') }
        : {}),
      ...(readOptionalString(record, 'conversationId') !== undefined
        ? { conversationId: readOptionalString(record, 'conversationId') }
        : {}),
      ...(readOptionalString(record, 'idempotencyKey') !== undefined
        ? { idempotencyKey: readOptionalString(record, 'idempotencyKey') }
        : {}),
    };
  }
  return null;
}

export function parseAgentServerMessage(raw: unknown): AgentServerMessage | null {
  const record = readJsonRecord(raw);
  if (!record) return null;
  return parseAgentServerRecord(record);
}

export function buildAgentEventEnvelope(
  event: AgentRuntimeEvent,
): AgentRuntimeEventEnvelope {
  return {
    type: 'event',
    requestId: event.requestId,
    event,
  };
}

function isOperationPhase(value: string | null): value is AgentOperationPhase {
  return value === 'started'
    || value === 'updated'
    || value === 'completed'
    || value === 'failed'
    || value === 'interrupted';
}

function normalizeOperationSourceProvider(value: string | null): 'toolkit' | 'runtime' | null {
  if (value === 'toolkit' || value === 'runtime') return value;
  return null;
}
