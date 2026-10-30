import { readPetInvocationContext, type PetInvocationScope } from 'pinpawo/host-runtime';
import { isJsonObject, isJsonValue, type JsonObject } from '@pinpawo/agent-contracts';

export type StudioDispatchRequest = {
  petId: string;
  /** In-process Plugin only: a reserved session target, never accepted from the wire. */
  session?: { id: string; create?: boolean };
  request: string;
  /** Producer-owned correlation data echoed by Studio; never passed to the Pet. */
  metadata?: JsonObject;
  idempotencyKey?: string;
  /**
   * In-process Plugin only: domain scope the Host admits as trusted. A wire
   * caller cannot claim it, or it could publish into another Plugin's domain.
   */
  scope?: PetInvocationScope;
};

/** The public wire form: Host-trusted targeting fields are deliberately absent. */
export type StudioWireDispatchRequest = Omit<StudioDispatchRequest, 'session' | 'scope'>;

/** Proof that Studio accepted the one-way dispatch; not an Agent execution handle. */
export type StudioDispatchReceipt = {
  petId: string;
  invocationId: string;
  metadata?: JsonObject;
};

/** The dispatch a Plugin's tool is running in, as Studio admitted it. */
export type StudioInvocation = {
  petId: string;
  invocationId: string;
  sessionId?: string;
  scope?: PetInvocationScope;
};

/**
 * Read from inside a Plugin Toolkit's tool: the admitted dispatch this call
 * belongs to, or undefined outside one. Tool arguments can never supply it.
 */
export function readStudioInvocation(): StudioInvocation | undefined {
  const context = readPetInvocationContext();
  if (!context) return undefined;
  return {
    petId: context.petId,
    invocationId: context.dispatchId,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.scope ? { scope: context.scope } : {}),
  };
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every((key) => allowed.has(key));
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Parse the transport-neutral JSON form of one Studio dispatch request. */
export function parseStudioDispatchRequest(value: unknown): StudioWireDispatchRequest | null {
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
