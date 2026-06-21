import stringWidth from 'string-width';
import { TUI_TEXT } from '../render/text';
import { formatElapsed, truncateLine } from '../render/terminalText';
import type {
  AgentOperationEntry,
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
