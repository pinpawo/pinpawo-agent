import { TUI_TEXT } from '../render/text';
import { formatElapsed, wrapLine } from '../render/terminalText';
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
  return wrapLine(buildAgentOperationText(entry, now), width).map((text, index) => ({
    id: `${entry.id}:line:${index}`,
    text,
  }));
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

function buildAgentOperationText(entry: AgentOperationEntry, now: number) {
  const detail = buildOperationDetail(entry);
  if (entry.phase === 'failed') {
    return joinParts([entry.title, TUI_TEXT.operationFailed, detail]);
  }
  if (entry.phase === 'interrupted') {
    return joinParts([entry.title, TUI_TEXT.operationInterrupted, detail]);
  }
  if (entry.phase === 'completed') {
    return joinParts([entry.title, detail || TUI_TEXT.operationCompleted]);
  }
  return joinParts([entry.title, formatElapsed(entry.startedAt, now), detail]);
}

function buildOperationDetail(entry: AgentOperationEntry) {
  return joinParts([
    entry.target,
    entry.summary,
    formatDetails(entry.details),
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

function joinParts(parts: Array<string | undefined>) {
  return parts.filter((part): part is string => Boolean(part)).join(' · ');
}
