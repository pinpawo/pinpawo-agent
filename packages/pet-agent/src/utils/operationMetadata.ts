/**
 * Shared operation-metadata helpers for capability and toolkit metadata consumers
 * outside host runtime.
 *
 * NOTE:
 *  - This file owns schema-safe readers and common capability-host summaries.
 *  - Tool kind values are still defined by each toolkit/capability provider.
 */
export function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function readString(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function readNumber(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === 'number' ? value : undefined;
}

export function readBoolean(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function readStringArray(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function readJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return readRecord(value);
  try {
    return readRecord(JSON.parse(value));
  } catch {
    return null;
  }
}
