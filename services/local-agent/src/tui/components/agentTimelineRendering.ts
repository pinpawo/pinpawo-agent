import stringWidth from 'string-width';
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

const OPERATION_DIFF_DETAIL_KEYS = new Set([
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
  const diffLines = buildOperationDiffLines(entry, width);
  diffLines.forEach((line, index) => {
    lines.push({
      ...line,
      id: `${entry.id}:diff:${index.toString()}`,
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
      if (OPERATION_DIFF_DETAIL_KEYS.has(key)) return [];
      if (value === undefined || value === null || value === '') return [];
      return [`${key}=${String(value)}`];
    })
    .join(' · ');
}

function buildOperationDiffLines(entry: AgentOperationEntry, width: number): TimelineTextLineDraft[] {
  const details = entry.details;
  if (!details) return [];

  const patch = readDetailString(details, 'patch');
  if (patch) {
    return buildPatchDiffLines(patch, entry.target, width);
  }

  const before = readDetailString(details, 'before');
  const after = readAfterContent(details, before);
  if (before === undefined && after === undefined) {
    return [];
  }
  return buildBeforeAfterDiffLines(before ?? '', after ?? '', entry.target, width);
}

function readAfterContent(details: Record<string, unknown>, before: string | undefined) {
  const after = readDetailString(details, 'after');
  if (after !== undefined) return after;

  const afterPreview = readDetailString(details, 'afterPreview');
  if (afterPreview === undefined) return undefined;
  if (readDetailBoolean(details, 'append') && before !== undefined) {
    return `${before}${afterPreview}`;
  }
  return afterPreview;
}

function readDetailString(details: Record<string, unknown>, key: string) {
  const value = details[key];
  return typeof value === 'string' ? value : undefined;
}

function readDetailBoolean(details: Record<string, unknown>, key: string) {
  const value = details[key];
  return typeof value === 'boolean' ? value : false;
}

function buildBeforeAfterDiffLines(
  before: string,
  after: string,
  target: string | undefined,
  width: number,
): TimelineTextLineDraft[] {
  if (before === after) return [];

  const beforeLines = splitContentLines(before);
  const afterLines = splitContentLines(after);
  const [removed, added] = changedLineRanges(beforeLines, afterLines);
  if (removed.length === 0 && added.length === 0) return [];

  return limitDiffLines([
    diffMetaLine(target ? `diff ${target}` : 'diff', width),
    ...removed.map((line) => diffLine('-', line, 'removed', width)),
    ...added.map((line) => diffLine('+', line, 'added', width)),
  ], width);
}

function buildPatchDiffLines(
  patch: string,
  target: string | undefined,
  width: number,
): TimelineTextLineDraft[] {
  const patchLines = patch
    .replace(/\r\n/g, '\n')
    .split('\n')
    .flatMap((line) => patchPreviewLine(line, width));
  if (patchLines.length === 0) return [];
  return limitDiffLines([
    diffMetaLine(target ? `patch ${target}` : 'patch', width),
    ...patchLines,
  ], width);
}

function patchPreviewLine(line: string, width: number): TimelineTextLineDraft[] {
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

function splitContentLines(content: string) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function changedLineRanges(before: string[], after: string[]): [string[], string[]] {
  let prefix = 0;
  while (
    prefix < before.length
    && prefix < after.length
    && before[prefix] === after[prefix]
  ) {
    prefix += 1;
  }

  let beforeSuffix = before.length - 1;
  let afterSuffix = after.length - 1;
  while (
    beforeSuffix >= prefix
    && afterSuffix >= prefix
    && before[beforeSuffix] === after[afterSuffix]
  ) {
    beforeSuffix -= 1;
    afterSuffix -= 1;
  }

  return [
    before.slice(prefix, beforeSuffix + 1),
    after.slice(prefix, afterSuffix + 1),
  ];
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

function joinUniqueParts(parts: Array<string | undefined>) {
  const seen = new Set<string>();
  return parts.flatMap((part) => {
    const text = part?.trim();
    if (!text || seen.has(text)) return [];
    seen.add(text);
    return [text];
  }).join(' · ');
}
