import type { ToolkitOperationSummary } from '@pinpawo/pet-agent';

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

export function readJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return readRecord(value);
  try {
    return readRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

export function pathInputSummary(input: unknown): ToolkitOperationSummary | null {
  const record = readRecord(input);
  const target = readString(record, 'path');
  return target ? { target } : null;
}

export function sourceDestinationInputSummary(input: unknown): ToolkitOperationSummary | null {
  const record = readRecord(input);
  const source = readString(record, 'source');
  const destination = readString(record, 'destination');
  return source || destination
    ? { target: destination ?? source, details: { source, destination } }
    : null;
}

export function okOutputPathSummary(output: unknown, pathField = 'path'): ToolkitOperationSummary | null {
  const record = readJsonRecord(output);
  const target = readString(record, pathField);
  return target ? { target } : null;
}
