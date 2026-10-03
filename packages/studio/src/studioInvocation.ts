import type { PetInvocationScope } from 'pinpawo/host-runtime';
import { isJsonObject, isJsonValue, type JsonObject } from '@pinpawo/agent-contracts';

export type StudioDispatchRequest = {
  petId: string;
  request: string;
  /** Producer-owned correlation data echoed by Studio; never passed to the Pet. */
  metadata?: JsonObject;
  idempotencyKey?: string;
  /** Explicit domain scope admitted by the Host, separate from correlation metadata. */
  scope?: PetInvocationScope;
};

/** Proof that Studio accepted the one-way dispatch; not an Agent execution handle. */
export type StudioDispatchReceipt = {
  petId: string;
  invocationId: string;
  metadata?: JsonObject;
};

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
    || !hasOnlyKeys(value, ['petId', 'request', 'metadata', 'idempotencyKey', 'scope'])
    || (value.scope !== undefined && (!isJsonObject(value.scope)
      || !hasOnlyKeys(value.scope, ['namespace', 'id'])
      || typeof value.scope.namespace !== 'string' || !value.scope.namespace.trim()
      || typeof value.scope.id !== 'string' || !value.scope.id.trim()))
    || (value.metadata !== undefined && (!isJsonObject(value.metadata) || !isJsonValue(value.metadata)))
    || (value.idempotencyKey !== undefined && !idempotencyKey)
  ) return null;
  return {
    petId,
    request,
    ...(value.metadata !== undefined ? { metadata: value.metadata as JsonObject } : {}),
    ...(value.scope !== undefined ? { scope: { ...(value.scope as PetInvocationScope) } } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}
