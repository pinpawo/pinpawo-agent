import stringWidth from 'string-width';
import {
  parsePatch,
  type PatchChunk,
  type PatchChunkLine,
  type PatchOperation,
} from '../../toolkits/local/applyPatch';
import { TUI_TEXT } from '../render/text';
import { formatElapsed, truncateLine } from '../render/terminalText';
import type {
  AgentOperationEntry,
} from '../timeline/agentTimeline';

export type TimelineTextLine = {
  id: string;
  text: string;
  tone?: 'default' | 'muted' | 'added' | 'removed';
};

type TimelineTextLineDraft = Omit<TimelineTextLine, 'id'>;

const OPERATION_PAYLOAD_DETAIL_KEYS = new Set([
  'after',
  'afterPreview',
  'before',
  'files',
  'patch',
]);
const MAX_OPERATION_DIFF_LINES = 24;

export function buildAgentOperationDisplayLines(
  entry: AgentOperationEntry,
  now: number,
  width: number,
): TimelineTextLine[] {
  const lines: TimelineTextLine[] = [{
    id: `${entry.id}:line`,
    text: buildAgentOperationText(entry, now, width),
  }];
  const payloadLines = buildOperationPayloadLines(entry, width);
  payloadLines.forEach((line, index) => {
    lines.push({
      ...line,
      id: `${entry.id}:payload:${index.toString()}`,
    });
  });
  return lines;
}

function buildAgentOperationText(entry: AgentOperationEntry, now: number, width: number) {
  const status = buildOperationStatus(entry, now);
  const suffix = `（${status}）`;
  const body = buildOperationBody(entry);
  const line = `${body}${suffix}`;
  if (stringWidth(line) <= width) return line;

  const suffixWidth = stringWidth(suffix);
  if (suffixWidth >= width) return truncateLine(suffix, width);
  return `${truncateLine(body, width - suffixWidth)}${suffix}`;
}

function buildOperationStatus(entry: AgentOperationEntry, now: number) {
  switch (entry.phase) {
    case 'started':
      return TUI_TEXT.operationStarted;
    case 'updated':
      return `${TUI_TEXT.operationRunning} ${formatElapsed(entry.startedAt, now)}`;
    case 'completed':
      return TUI_TEXT.operationCompleted;
    case 'failed':
      return TUI_TEXT.operationFailed;
    case 'interrupted':
      return TUI_TEXT.operationInterrupted;
  }
}

function buildOperationBody(entry: AgentOperationEntry) {
  return joinUniqueParts([
    entry.summary,
    entry.target,
    formatDetails(entry.details),
    entry.title,
  ]);
}

function formatDetails(details: Record<string, unknown> | undefined) {
  if (!details) return '';
  return Object.entries(details)
    .flatMap(([key, value]) => {
      if (OPERATION_PAYLOAD_DETAIL_KEYS.has(key)) return [];
      if (value === undefined || value === null || value === '') return [];
      return [`${key}=${String(value)}`];
    })
    .join(' · ');
}

function buildOperationPayloadLines(entry: AgentOperationEntry, width: number): TimelineTextLineDraft[] {
  if (!isApplyPatchOperation(entry)) return [];
  const patch = readApplyPatchPayload(entry);
  return patch ? buildPatchDiffLines(patch, entry.target, width) : [];
}

function readDetailString(details: Record<string, unknown>, key: string) {
  const value = details[key];
  return typeof value === 'string' ? value : undefined;
}

function buildPatchDiffLines(
  patch: string,
  target: string | undefined,
  width: number,
): TimelineTextLineDraft[] {
  const patchLines = buildParsedPatchLines(patch, width) ?? buildRawPatchLines(patch, width);
  if (patchLines.length === 0) return [];
  return limitDiffLines([
    diffMetaLine(target ? `patch ${target}` : 'patch', width),
    ...patchLines,
  ], width);
}

function buildParsedPatchLines(patch: string, width: number): TimelineTextLineDraft[] | null {
  try {
    return parsePatch(patch).flatMap((operation) => patchOperationLines(operation, width));
  } catch {
    return null;
  }
}

function patchOperationLines(operation: PatchOperation, width: number): TimelineTextLineDraft[] {
  switch (operation.type) {
    case 'add':
      return [
        diffMetaLine(`*** Add File: ${operation.path}`, width),
        ...splitPatchContentLines(operation.content).map((line) => diffLine('+', line, 'added', width)),
      ];
    case 'delete':
      return [diffMetaLine(`*** Delete File: ${operation.path}`, width)];
    case 'update':
      return [
        diffMetaLine(`*** Update File: ${operation.path}`, width),
        ...(operation.moveTo ? [diffMetaLine(`*** Move to: ${operation.moveTo}`, width)] : []),
        ...operation.chunks.flatMap((chunk) => patchChunkLines(chunk, width)),
      ];
  }
}

function patchChunkLines(chunk: PatchChunk, width: number): TimelineTextLineDraft[] {
  return [
    diffMetaLine(chunk.anchor ? `@@ ${chunk.anchor}` : '@@', width),
    ...chunk.lines.map((line) => patchChunkLine(line, width)),
    ...(chunk.isEndOfFile ? [diffMetaLine('*** End of File', width)] : []),
  ];
}

function buildRawPatchLines(patch: string, width: number): TimelineTextLineDraft[] {
  return patch
    .replace(/\r\n/g, '\n')
    .split('\n')
    .flatMap((line) => rawPatchLine(line, width));
}

function rawPatchLine(line: string, width: number): TimelineTextLineDraft[] {
  const trimmed = line.trimEnd();
  if (!trimmed || trimmed === '*** Begin Patch' || trimmed === '*** End Patch') {
    return [];
  }
  return [{
    text: truncateLine(`  ${trimmed}`, width),
    tone: patchLineTone(trimmed),
  }];
}

function patchLineTone(line: string): TimelineTextLineDraft['tone'] {
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  return 'muted';
}

function splitPatchContentLines(content: string) {
  if (!content) return [''];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function patchChunkLine(line: PatchChunkLine, width: number): TimelineTextLineDraft {
  switch (line.kind) {
    case 'added':
      return diffLine('+', line.text, 'added', width);
    case 'removed':
      return diffLine('-', line.text, 'removed', width);
    case 'context':
      return {
        text: truncateLine(`   ${line.text}`, width),
        tone: 'muted',
      };
  }
}

function diffMetaLine(text: string, width: number): TimelineTextLineDraft {
  return {
    text: truncateLine(`  ${text}`, width),
    tone: 'muted',
  };
}

function diffLine(
  prefix: '+' | '-',
  line: string,
  tone: 'added' | 'removed',
  width: number,
): TimelineTextLineDraft {
  return {
    text: truncateLine(`  ${prefix}${line}`, width),
    tone,
  };
}

function limitDiffLines(lines: TimelineTextLineDraft[], width: number): TimelineTextLineDraft[] {
  if (lines.length <= MAX_OPERATION_DIFF_LINES) return lines;
  const visibleLines = lines.slice(0, MAX_OPERATION_DIFF_LINES - 1);
  visibleLines.push({
    text: truncateLine(`  … ${(
      lines.length - visibleLines.length
    ).toString()} diff lines hidden`, width),
    tone: 'muted',
  });
  return visibleLines;
}

function isApplyPatchOperation(entry: AgentOperationEntry) {
  return entry.source?.toolName === 'apply_patch'
    || entry.kind.endsWith('.apply_patch')
    || entry.kind === 'apply_patch';
}

function readApplyPatchPayload(entry: AgentOperationEntry) {
  return readPatchFromRawInput(entry.raw?.input)
    ?? (entry.details ? readDetailString(entry.details, 'patch') : undefined);
}

function readPatchFromRawInput(input: unknown): string | undefined {
  if (input && typeof input === 'object' && 'patch' in input) {
    const patch = (input as { patch?: unknown }).patch;
    return typeof patch === 'string' ? patch : undefined;
  }
  if (typeof input !== 'string') return undefined;
  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed && typeof parsed === 'object' && 'patch' in parsed) {
      const patch = (parsed as { patch?: unknown }).patch;
      return typeof patch === 'string' ? patch : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function joinUniqueParts(parts: Array<string | undefined>) {
  const seen = new Set<string>();
  return parts.flatMap((part) => {
    const text = part?.trim();
    if (!text || seen.has(text)) return [];
    seen.add(text);
    return [text];
  }).join(' · ');
}
