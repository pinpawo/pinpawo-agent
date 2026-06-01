import type { LocalAgentOperationEvent } from '../../events/localAgentEvent';
import { TUI_TEXT } from './text';

const MAX_DIFF_LINES = 80;
const MAX_DIFF_LINE_LENGTH = 180;

type TextEditPreview = {
  oldText: string;
  newText: string;
};

export function formatOperationDiffPreview(event: LocalAgentOperationEvent): string | null {
  if (event.phase !== 'completed' && event.phase !== 'failed') return null;

  switch (event.operation.kind) {
    case 'file.write':
      return formatWriteFilePreview(event);
    case 'file.update':
      return formatTextEditPreview(event, readUpdateFileEdits);
    case 'file.multi_edit':
      return formatTextEditPreview(event, readMultiEditEdits);
    case 'file.patch':
      return formatTextEditPreview(event, readFilePatchEdits);
    case 'patch.apply':
      return formatUnifiedPatchPreview(event);
    case 'shell.run':
      return formatShellDiffPreview(event);
    default:
      return null;
  }
}

function formatWriteFilePreview(event: LocalAgentOperationEvent) {
  const input = readRecord(event.raw?.input);
  const target = readString(input, 'path') ?? event.operation.target;
  const content = readString(input, 'content');
  if (!target || content === undefined) return null;

  const append = readBoolean(input, 'append');
  return formatDiffBlock([
    `--- ${target}`,
    `+++ ${target}`,
    `@@ ${append ? 'append' : 'write'} @@`,
    ...prefixTextLines('+', content),
  ]);
}

function formatTextEditPreview(
  event: LocalAgentOperationEvent,
  readEdits: (input: Record<string, unknown> | null) => TextEditPreview[],
) {
  const input = readRecord(event.raw?.input);
  const target = readString(input, 'path') ?? event.operation.target;
  const edits = readEdits(input);
  if (!target || edits.length === 0) return null;

  const lines = [
    `--- ${target}`,
    `+++ ${target}`,
  ];
  edits.forEach((edit, index) => {
    lines.push(
      `@@ edit ${index + 1} @@`,
      ...prefixTextLines('-', edit.oldText),
      ...prefixTextLines('+', edit.newText),
    );
  });
  return formatDiffBlock(lines);
}

function formatUnifiedPatchPreview(event: LocalAgentOperationEvent) {
  const input = readRecord(event.raw?.input);
  const patch = readString(input, 'patch');
  return patch ? formatDiffBlock(patch.split(/\r?\n/)) : null;
}

function formatShellDiffPreview(event: LocalAgentOperationEvent) {
  const output = readText(event.raw?.output);
  if (!output) return null;
  const diffLines = extractUnifiedDiffLines(output);
  return diffLines ? formatDiffBlock(diffLines) : null;
}

function formatDiffBlock(lines: string[]) {
  const limited = limitDiffLines(lines);
  return [
    TUI_TEXT.diffPreviewHeader,
    '```diff',
    ...limited,
    '```',
  ].join('\n');
}

function limitDiffLines(lines: string[]) {
  const normalized = lines
    .map((line) => truncateLine(line.replace(/\t/g, '  ')))
    .filter((line, index, all) => index < all.length - 1 || line.trim() !== '');
  if (normalized.length <= MAX_DIFF_LINES) return normalized;
  return [
    ...normalized.slice(0, MAX_DIFF_LINES),
    TUI_TEXT.diffPreviewTruncated(normalized.length - MAX_DIFF_LINES),
  ];
}

function truncateLine(line: string) {
  return line.length > MAX_DIFF_LINE_LENGTH
    ? `${line.slice(0, MAX_DIFF_LINE_LENGTH - 1)}…`
    : line;
}

function prefixTextLines(prefix: '+' | '-', text: string) {
  const lines = text.split(/\r?\n/);
  return lines.map((line) => `${prefix}${line}`);
}

function readUpdateFileEdits(input: Record<string, unknown> | null) {
  const find = readString(input, 'find');
  const replace = readString(input, 'replace');
  return find !== undefined && replace !== undefined
    ? [{ oldText: find, newText: replace }]
    : [];
}

function readMultiEditEdits(input: Record<string, unknown> | null) {
  const edits = input?.edits;
  if (!Array.isArray(edits)) return [];
  return edits.flatMap((edit) => {
    const record = readRecord(edit);
    const find = readString(record, 'find');
    const replace = readString(record, 'replace');
    return find !== undefined && replace !== undefined
      ? [{ oldText: find, newText: replace }]
      : [];
  });
}

function readFilePatchEdits(input: Record<string, unknown> | null) {
  const hunks = input?.hunks;
  if (!Array.isArray(hunks)) return [];
  return hunks.flatMap((hunk) => {
    const record = readRecord(hunk);
    const oldText = readString(record, 'oldText');
    const newText = readString(record, 'newText');
    return oldText !== undefined && newText !== undefined
      ? [{ oldText, newText }]
      : [];
  });
}

function extractUnifiedDiffLines(text: string) {
  const lines = text.split(/\r?\n/);
  const firstDiffLine = lines.findIndex((line) =>
    line.startsWith('diff --git ')
    || line.startsWith('--- ')
    || line.startsWith('*** Begin Patch'));
  if (firstDiffLine === -1) return null;
  const diffLines = lines.slice(firstDiffLine);
  return looksLikeDiff(diffLines) ? diffLines : null;
}

function looksLikeDiff(lines: string[]) {
  return lines.some((line) => line.startsWith('@@ ') || line.startsWith('+++ ') || line.startsWith('*** Update File:'));
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readText(value: unknown) {
  return typeof value === 'string' ? value : null;
}
