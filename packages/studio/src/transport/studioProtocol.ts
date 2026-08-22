import {
  isJsonObject,
  isJsonValue,
  parseHumanReviewResponse,
  type JsonObject,
} from '@pinpawo/agent-contracts';
import type {
  StudioDispatchInput,
  StudioInvocationEvent,
} from '../studioContract';

export type StudioDispatchMessage = {
  type: 'studio.dispatch';
  /** Transport correlation only; not a Studio invocation identity. */
  deliveryId: string;
  petId: string;
  input: StudioDispatchInput;
  metadata?: JsonObject;
  idempotencyKey?: string;
};

export type StudioClientMessage = StudioDispatchMessage | { type: 'ping' };

export type StudioServerMessage =
  | { type: 'pong' }
  | {
      type: 'studio.accepted';
      deliveryId: string;
      petId: string;
      threadId: string;
      invocationId: string;
      metadata?: JsonObject;
    }
  | ({ type: 'studio.invocation'; deliveryId: string } & StudioInvocationEvent)
  | { type: 'studio.error'; deliveryId: string; message: string };

export type StudioClientMessageEnvelope = {
  type?: string;
  deliveryId?: string;
};

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]) {
  const allowed = new Set(keys);
  return Object.keys(record).every((key) => allowed.has(key));
}

function readNonEmptyString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseInput(value: unknown): StudioDispatchInput | null {
  if (!isJsonObject(value)) return null;
  if (value.kind === 'request') {
    return hasOnlyKeys(value, ['kind', 'request']) && typeof value.request === 'string'
      ? { kind: 'request', request: value.request }
      : null;
  }
  if (
    value.kind !== 'resume_interrupt'
    || !hasOnlyKeys(value, ['kind', 'interruptId', 'payload'])
  ) return null;
  const interruptId = readNonEmptyString(value, 'interruptId');
  const payload = value.payload;
  if (
    !interruptId
    || !isJsonObject(payload)
    || !hasOnlyKeys(payload, ['kind', 'responses'])
    || payload.kind !== 'human_review_response'
    || !Array.isArray(payload.responses)
    || payload.responses.length === 0
  ) return null;
  const responses = payload.responses.map(parseHumanReviewResponse);
  if (responses.some((response) => response === null)) return null;
  return {
    kind: 'resume_interrupt',
    interruptId,
    payload: {
      kind: 'human_review_response',
      responses: responses as NonNullable<(typeof responses)[number]>[],
    },
  };
}

function normalize(raw: unknown): unknown {
  const value = raw instanceof Buffer ? raw.toString('utf8') : raw;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function readStudioClientMessageEnvelope(raw: unknown): StudioClientMessageEnvelope | null {
  const value = normalize(raw);
  if (!isJsonObject(value)) return null;
  return {
    ...(typeof value.type === 'string' ? { type: value.type } : {}),
    ...(typeof value.deliveryId === 'string' ? { deliveryId: value.deliveryId } : {}),
  };
}

export function parseStudioClientMessage(raw: unknown): StudioClientMessage | null {
  const value = normalize(raw);
  if (!isJsonObject(value) || typeof value.type !== 'string') return null;
  if (value.type === 'ping') {
    return hasOnlyKeys(value, ['type']) ? { type: 'ping' } : null;
  }
  if (value.type !== 'studio.dispatch') return null;
  const deliveryId = readNonEmptyString(value, 'deliveryId');
  const petId = readNonEmptyString(value, 'petId');
  const input = parseInput(value.input);
  const idempotencyKey = value.idempotencyKey === undefined
    ? undefined
    : readNonEmptyString(value, 'idempotencyKey');
  if (
    !deliveryId
    || !petId
    || !input
    || !hasOnlyKeys(value, [
      'type',
      'deliveryId',
      'petId',
      'input',
      'metadata',
      'idempotencyKey',
    ])
    || (value.metadata !== undefined && (!isJsonObject(value.metadata) || !isJsonValue(value.metadata)))
    || (value.idempotencyKey !== undefined && !idempotencyKey)
  ) return null;
  return {
    type: 'studio.dispatch',
    deliveryId,
    petId,
    input,
    ...(value.metadata !== undefined ? { metadata: value.metadata as JsonObject } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}
