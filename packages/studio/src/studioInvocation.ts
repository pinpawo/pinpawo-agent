import {
  isJsonObject,
  isJsonValue,
  type JsonObject,
} from '@pinpawo/agent-contracts';

/**
 * Public description of a Pet-owned durable wait. Studio preserves this
 * opaque payload for dispatch producers; only the Pet runtime interprets it.
 */
export type PendingContinuationProjection = {
  continuationId: string;
  payload: JsonObject;
};

export type StudioDispatchInput =
  | { kind: 'request'; request: string }
  | {
      /** Resume a Pet-owned continuation with a Pet-defined opaque payload. */
      kind: 'resume';
      continuationId: string;
      payload: JsonObject;
    };

export type StudioDispatchRequest = {
  petId: string;
  input: StudioDispatchInput;
  /** Producer-owned correlation data echoed by Studio; never passed to the Pet runtime. */
  metadata?: JsonObject;
  /** Deduplicates an explicitly retried dispatch for this Pet and Host generation. */
  idempotencyKey?: string;
  signal?: AbortSignal;
};

export type StudioInvocationTerminalStatus =
  | 'completed'
  | 'waiting'
  | 'failed'
  | 'cancelled';

export type StudioDispatchResult = {
  petId: string;
  threadId: string;
  invocationId: string;
  status: StudioInvocationTerminalStatus;
  metadata?: JsonObject;
  output?: string;
  pendingContinuation?: PendingContinuationProjection;
  error?: string;
};

/**
 * Immediate acknowledgement of one accepted dispatch. Completion settles when
 * its serialized graph invocation reaches a terminal or durable-wait state.
 */
export type StudioDispatchReceipt = {
  petId: string;
  threadId: string;
  invocationId: string;
  metadata?: JsonObject;
  /**
   * Observe only this invocation. The latest event is replayed immediately so
   * a caller cannot miss progress emitted before the receipt was delivered.
   */
  onInvocation: (handler: StudioInvocationEventHandler) => () => void;
  completion: Promise<StudioDispatchResult>;
};

export type StudioInvocationEvent = {
  petId: string;
  threadId: string;
  invocationId: string;
  status: 'busy' | StudioInvocationTerminalStatus;
  metadata?: JsonObject;
  output?: string;
  pendingContinuation?: PendingContinuationProjection;
  error?: string;
};

export type StudioInvocationEventHandler =
  (event: StudioInvocationEvent) => void | Promise<void>;

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every((key) => allowed.has(key));
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseDispatchInput(value: unknown): StudioDispatchInput | null {
  if (!isJsonObject(value)) return null;
  if (value.kind === 'request') {
    return hasOnlyKeys(value, ['kind', 'request']) && typeof value.request === 'string'
      ? { kind: 'request', request: value.request }
      : null;
  }
  if (value.kind !== 'resume' || !hasOnlyKeys(value, ['kind', 'continuationId', 'payload'])) {
    return null;
  }
  const continuationId = readNonEmptyString(value, 'continuationId');
  const payload = value.payload;
  if (
    !continuationId
    || !isJsonObject(payload)
    || !isJsonValue(payload)
  ) return null;
  return {
    kind: 'resume',
    continuationId,
    payload,
  };
}

/** Parse the transport-neutral JSON form of one Studio dispatch request. */
export function parseStudioDispatchRequest(value: unknown): StudioDispatchRequest | null {
  if (!isJsonObject(value)) return null;
  const petId = readNonEmptyString(value, 'petId');
  const input = parseDispatchInput(value.input);
  const idempotencyKey = value.idempotencyKey === undefined
    ? undefined
    : readNonEmptyString(value, 'idempotencyKey');
  if (
    !petId
    || !input
    || !hasOnlyKeys(value, ['petId', 'input', 'metadata', 'idempotencyKey'])
    || (value.metadata !== undefined && (!isJsonObject(value.metadata) || !isJsonValue(value.metadata)))
    || (value.idempotencyKey !== undefined && !idempotencyKey)
  ) return null;
  return {
    petId,
    input,
    ...(value.metadata !== undefined ? { metadata: value.metadata as JsonObject } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

/** One deterministic checkpoint namespace for a resident Studio Pet. */
export function buildStudioPetThreadId(studioId: string, petId: string): string {
  return `studio:${encodeURIComponent(studioId)}:pet:${encodeURIComponent(petId)}`;
}
