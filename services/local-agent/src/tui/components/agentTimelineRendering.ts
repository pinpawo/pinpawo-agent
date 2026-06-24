import stringWidth from 'string-width';
import { TUI_TEXT } from '../render/text';
import { formatElapsed, truncateLine } from '../render/terminalText';
import type {
  AgentOperationEntry,
} from '../timeline/agentTimeline';
import { buildApplyPatchDisplayLines } from './applyPatchDisplay';

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
  return buildApplyPatchDisplayLines({ patch, target, width });
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
