import {
  AGENT_SESSION_SNAPSHOT_VERSION,
  type AgentSession,
} from './domain';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type AgentSessionSnapshotV4 = {
  version: typeof AGENT_SESSION_SNAPSHOT_VERSION;
  session: AgentSession;
};

export type AgentSessionSnapshot = AgentSessionSnapshotV4;

export function createAgentSessionSnapshot(
  session: AgentSession,
): AgentSessionSnapshot {
  return {
    version: AGENT_SESSION_SNAPSHOT_VERSION,
    session,
  };
}

export function isJsonValue(value: unknown): value is JsonValue {
  return isJsonValueInternal(value, new Set());
}

function isJsonValueInternal(
  value: unknown,
  seen: Set<object>,
): value is JsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  if (
    !Array.isArray(value)
    && Object.getPrototypeOf(value) !== Object.prototype
    && Object.getPrototypeOf(value) !== null
  ) {
    return false;
  }
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValueInternal(item, seen))
    : Object.values(value).every((item) => isJsonValueInternal(item, seen));
  seen.delete(value);
  return valid;
}
