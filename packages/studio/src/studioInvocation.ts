import { isJsonObject, isJsonValue, type JsonObject } from '@pinpawo/agent-contracts';

export type StudioDispatchRequest = {
  petId: string;
  request: string;
  /** Producer-owned correlation data echoed by Studio; never passed to the Pet. */
  metadata?: JsonObject;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

export type StudioInvocationTerminalStatus = 'completed' | 'waiting' | 'failed' | 'cancelled';

export type StudioDispatchResult = {
  petId: string;
  invocationId: string;
  status: StudioInvocationTerminalStatus;
  metadata?: JsonObject;
  output?: string;
  error?: string;
};

export type StudioDispatchReceipt = {
  petId: string;
  invocationId: string;
  metadata?: JsonObject;
  onInvocation: (handler: StudioInvocationEventHandler) => () => void;
  completion: Promise<StudioDispatchResult>;
};

export type StudioInvocationEvent = {
  petId: string;
  invocationId: string;
  status: 'busy' | StudioInvocationTerminalStatus;
  metadata?: JsonObject;
  output?: string;
  error?: string;
};

export type StudioInvocationEventHandler = (event: StudioInvocationEvent) => void | Promise<void>;

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every((key) => allowed.has(key));
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Parse the transport-neutral JSON form of one Studio dispatch request. */
export function parseStudioDispatchRequest(value: unknown): StudioDispatchRequest | null {
  if (!isJsonObject(value)) return null;
  const petId = readNonEmptyString(value, 'petId');
  const request = typeof value.request === 'string' ? value.request : null;
  const idempotencyKey = value.idempotencyKey === undefined
    ? undefined
    : readNonEmptyString(value, 'idempotencyKey');
  if (
    !petId
    || request === null
    || !hasOnlyKeys(value, ['petId', 'request', 'metadata', 'idempotencyKey'])
    || (value.metadata !== undefined && (!isJsonObject(value.metadata) || !isJsonValue(value.metadata)))
    || (value.idempotencyKey !== undefined && !idempotencyKey)
  ) return null;
  return {
    petId,
    request,
    ...(value.metadata !== undefined ? { metadata: value.metadata as JsonObject } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}
