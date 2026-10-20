import {
  readBoolean,
  readJsonRecord,
  readNumber,
  readRecord,
  readString,
  type OperationSummary,
} from '@pinpawo/pet-agent';
/**
 * Host toolkit metadata helpers.
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

export function pathInputSummary(input: unknown): OperationSummary | null {
  const record = readRecord(input);
  const target = readString(record, 'path');
  return target ? { target } : null;
}

export function sourceDestinationInputSummary(input: unknown): OperationSummary | null {
  const record = readRecord(input);
  const source = readString(record, 'source');
  const destination = readString(record, 'destination');
  return source || destination
    ? { target: destination ?? source, ...(source && destination ? { summary: `从 ${source}` } : {}) }
    : null;
}

/**
 * A command as the heading line, and verbatim in a code block: the heading is
 * folded to one line, which collapses quoted whitespace and newlines, so a
 * reviewer must also see exactly what will run.
 */
export function commandSummary(command: string, cwd?: string): OperationSummary {
  return {
    target: cwd,
    summary: command,
    blocks: [{ kind: 'code', text: command, language: 'shell' }],
  };
}
