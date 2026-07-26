import {
  readBoolean,
  readJsonRecord,
  readNumber,
  readRecord,
  readString,
  type ToolOperationSummary,
} from '@pinpawo/pet-agent';
/**
 * Local-agent toolkit metadata helpers.
 *
 * - Common record/read helpers are sourced from `@pinpawo/pet-agent`
 *   to keep behavior aligned with capability metadata.
 * - File/path helpers here are intentionally local-tool specific and are
 *   not part of shared pet-agent API surface.
 */
export {
  readBoolean,
  readJsonRecord,
  readNumber,
  readRecord,
  readString,
};

export function pathInputSummary(input: unknown): ToolOperationSummary | null {
  const record = readRecord(input);
  const target = readString(record, 'path');
  return target ? { target } : null;
}

export function sourceDestinationInputSummary(input: unknown): ToolOperationSummary | null {
  const record = readRecord(input);
  const source = readString(record, 'source');
  const destination = readString(record, 'destination');
  return source || destination
    ? { target: destination ?? source, details: { source, destination } }
    : null;
}

export function okOutputPathSummary(output: unknown, pathField = 'path'): ToolOperationSummary | null {
  const record = readJsonRecord(output);
  const target = readString(record, pathField);
  return target ? { target } : null;
}
