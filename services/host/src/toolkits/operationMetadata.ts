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
 * A command as the heading line; a multi-line command is also kept whole in a
 * code block, since the heading folds it to one line.
 */
export function commandSummary(command: string, cwd?: string): OperationSummary {
  return {
    target: cwd,
    summary: command,
    ...(command.includes('\n') ? { blocks: [{ kind: 'code', text: command, language: 'shell' }] } : {}),
  };
}
