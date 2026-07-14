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
  /**
   * When set, the line is the operation's header and should render a leading
   * status dot in this phase's color (gray=running, green=done, red=failed).
   */
  statusDot?: AgentOperationEntry['phase'];
};

type TimelineTextLineDraft = Omit<TimelineTextLine, 'id'>;

/** Columns reserved for the leading status dot and its trailing space ("● "). */
export const OPERATION_DOT_WIDTH = 2;

export const OPERATION_STATUS_DOT = '●';

/** Lead-in for the first output line under an operation, Claude-Code style. */
export const OPERATION_OUTPUT_LEAD = '  ⎿ ';
/** Indent for continuation output lines, aligned under the lead glyph. */
export const OPERATION_OUTPUT_INDENT = '    ';
/** Output lines shown before collapsing into a "+N lines" footer. */
export const OPERATION_OUTPUT_MAX_LINES = 6;

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
    // Reserve two columns for the leading status dot ("● ").
    text: buildAgentOperationText(entry, now, Math.max(0, width - OPERATION_DOT_WIDTH)),
    statusDot: entry.phase,
  }];
  const payloadLines = buildOperationPayloadLines(entry, width);
  payloadLines.forEach((line, index) => {
    lines.push({
      ...line,
      id: `${entry.id}:payload:${index.toString()}`,
    });
  });
  const outputLines = buildOperationOutputLines(entry, width);
  outputLines.forEach((line, index) => {
    lines.push({
      ...line,
      id: `${entry.id}:output:${index.toString()}`,
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
    case 'updated': {
      const elapsed = formatElapsed(entry.startedAt ?? entry.updatedAt ?? now, now);
      return `${TUI_TEXT.operationRunning} ${elapsed ?? TUI_TEXT.elapsedUnavailable}`;
    }
    case 'completed':
      return TUI_TEXT.operationCompleted;
    case 'failed':
      return TUI_TEXT.operationFailed;
    case 'interrupted':
      return TUI_TEXT.operationInterrupted;
  }
}

function buildOperationBody(entry: AgentOperationEntry) {
  const label = operationToolLabel(entry);
  const argument = operationArgument(entry);
  return argument ? `${label}(${argument})` : label;
}

/** The tool name shown as the header label, e.g. `apply_patch` or `打开网页`. */
function operationToolLabel(entry: AgentOperationEntry) {
  return entry.operationSource?.toolName?.trim()
    || entry.operationSource?.name?.trim()
    || entry.title?.trim()
    || entry.kind;
}

/** The parenthesized argument summary, e.g. the target path or a one-line summary. */
function operationArgument(entry: AgentOperationEntry) {
  const label = operationToolLabel(entry);
  const detailText = formatDetails(entry.details);
  return joinUniqueParts([
    entry.target,
    entry.summary,
    detailText,
  ].filter((part) => part?.trim() !== label));
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

/**
 * Renders the tool's raw output (or error) as `⎿`-led, indented muted lines,
 * collapsing long output to a "+N lines" footer. apply_patch keeps its diff
 * rendering instead of dumping raw output.
 */
function buildOperationOutputLines(entry: AgentOperationEntry, width: number): TimelineTextLineDraft[] {
  if (isApplyPatchOperation(entry)) return [];
  const isError = entry.phase === 'failed';
  const raw = isError ? (entry.raw?.error ?? entry.raw?.output) : entry.raw?.output;
  const text = stringifyOutput(raw);
  if (!text) return [];

  const rawLines = text.replace(/\r\n/g, '\n').split('\n');
  const lines = rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines;
  return buildOutputDisplayLines(lines, width, isError);
}

function buildOutputDisplayLines(
  lines: string[],
  width: number,
  isError: boolean,
): TimelineTextLineDraft[] {
  const tone: TimelineTextLine['tone'] = isError ? 'removed' : 'muted';
  const visible = lines.slice(0, OPERATION_OUTPUT_MAX_LINES);
  const hidden = lines.length - visible.length;
  const out = visible.map((line, index) => ({
    text: truncateLine(`${index === 0 ? OPERATION_OUTPUT_LEAD : OPERATION_OUTPUT_INDENT}${line}`, width),
    tone,
  }));
  if (hidden > 0) {
    out.push({
      text: truncateLine(`${OPERATION_OUTPUT_INDENT}… +${hidden.toString()} lines`, width),
      tone: 'muted',
    });
  }
  return out;
}

function stringifyOutput(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2).trim();
  } catch {
    return '';
  }
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
  return entry.operationSource?.toolName === 'apply_patch'
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
