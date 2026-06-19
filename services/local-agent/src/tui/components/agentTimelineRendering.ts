import stringWidth from 'string-width';
import { TUI_TEXT } from '../render/text';
import { formatElapsed, truncateLine } from '../render/terminalText';
import type {
  AgentOperationEntry,
  AgentReviewEntry,
} from '../timeline/agentTimeline';

export type TimelineTextLine = {
  id: string;
  text: string;
};

export function buildAgentOperationDisplayLines(
  entry: AgentOperationEntry,
  now: number,
  width: number,
): TimelineTextLine[] {
  return [{
    id: `${entry.id}:line`,
    text: buildAgentOperationText(entry, now, width),
  }];
}

export function buildAgentReviewText(entry: AgentReviewEntry) {
  switch (entry.status) {
    case 'answered':
      return '确认已提交';
    case 'interrupted':
      return '确认已中断';
    case 'waiting':
      return TUI_TEXT.approvalWaiting();
  }
}

function buildAgentOperationText(entry: AgentOperationEntry, now: number, width: number) {
  const status = buildOperationStatus(entry, now);
  const suffix = `（${status}）`;
  const body = buildOperationBody(entry);
  const line = `${body}${suffix}`;
  if (stringDisplayWidth(line) <= width) return line;

  const suffixWidth = stringDisplayWidth(suffix);
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
      if (value === undefined || value === null || value === '') return [];
      return [`${key}=${String(value)}`];
    })
    .join(' · ');
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

function stringDisplayWidth(text: string) {
  return stringWidth(text);
}
