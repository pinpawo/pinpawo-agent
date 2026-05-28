export function safeParseJson(text: string) {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function shorten(value: string, max = 60) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

export function readString(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === 'string' ? value : null;
}

export function readNumber(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === 'number' ? value : null;
}

export function readBoolean(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : false;
}

export function readObject(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
