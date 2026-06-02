import type { ToolkitOperationSummary } from '../types/toolkit';

export function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function readString(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
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

export function readToolArtifactRecord(output: unknown): Record<string, unknown> | null {
  if (Array.isArray(output)) {
    return readRecord(output[1]) ?? readJsonRecord(output[0]);
  }
  const record = readRecord(output);
  if (record && 'artifact' in record) {
    return readRecord(record.artifact) ?? readJsonRecord(record.artifact);
  }
  return readJsonRecord(output);
}

export function resultStatusSummary(
  output: unknown,
  labels: Record<string, string>,
): ToolkitOperationSummary | null {
  const record = readToolArtifactRecord(output);
  if (!record) return null;
  const status = readString(record, 'status');
  const postId = readString(record, 'postId');
  const capabilityId = readString(record, 'capabilityId');
  const rootDir = readString(record, 'rootDir');
  const note = readString(record, 'note');
  const reason = readString(record, 'reason');
  const warnings = Array.isArray(record.warnings) ? record.warnings : [];
  const files = Array.isArray(record.files) ? record.files : [];
  return status || postId || capabilityId || rootDir || note || reason
    ? {
        target: postId ?? rootDir ?? capabilityId,
        summary: status ? labels[status] ?? status : note,
        details: {
          status,
          postId,
          capabilityId,
          rootDir,
          reason,
          warningCount: warnings.length,
          fileCount: files.length,
          imageRequested: readBoolean(record, 'imageRequested'),
        },
      }
    : null;
}
