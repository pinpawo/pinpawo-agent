import type {
  LocalAgentOperationEvent,
  LocalAgentSystemNoticeEvent,
  LocalAgentStudioProgressEvent,
} from '../../events/localAgentEvent';
import { TUI_TEXT } from './text';
import { formatElapsed, wrapLine } from './terminalText';
import type { ActiveOperation, PendingUiState } from '../types';

const SUBAGENT_TEXT_LINE_CHARS = 64;

export function shorten(value: string, max = 60) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

export function getOperationKey(event: LocalAgentOperationEvent) {
  return event.operation.id
    ?? event.operation.source?.callId
    ?? event.operation.source?.name
    ?? event.operation.kind;
}

export function formatOperationStart(event: LocalAgentOperationEvent) {
  return {
    label: event.operation.title ?? event.operation.kind,
    detail: formatOperationDetail(event) || event.operation.kind,
  };
}

export function formatOperationProgress(event: LocalAgentOperationEvent) {
  return formatOperationDetail(event);
}

export function formatOperationResult(event: LocalAgentOperationEvent) {
  const label = event.operation.title ?? event.operation.kind;
  if (event.phase === 'failed') {
    const detail = formatOperationDetail(event, 80);
    return `${label}：${TUI_TEXT.operationFailed}${detail ? ` · ${detail}` : ''}`;
  }
  if (event.phase === 'interrupted') {
    return `${label}：${TUI_TEXT.operationInterrupted}`;
  }
  const detail = formatOperationDetail(event, 80);
  return `${label}：${detail || TUI_TEXT.operationCompleted}`;
}

export function formatSystemNoticeEvent(event: LocalAgentSystemNoticeEvent): string | null {
  const notice = event.message.trim();
  return notice || null;
}

export function formatSubagentMessage(text: string): string | null {
  const content = formatSubagentTextBody(text);
  return content ? TUI_TEXT.subagentOutput(content) : null;
}

export function formatStudioProgressEvent(event: LocalAgentStudioProgressEvent): string | null {
  const payload = event.event;
  const type = typeof payload.type === 'string' ? payload.type : null;
  if (!type) return null;
  switch (type) {
    case 'turn_started':
    case 'turn_finished':
      return null;
    case 'tasks_queued': {
      const taskCount = typeof payload.taskCount === 'number' ? payload.taskCount : 0;
      return TUI_TEXT.studioProgressTasksQueued(taskCount);
    }
    case 'task_started': {
      const petId = typeof payload.petId === 'string' ? payload.petId : '?';
      const taskIndex = typeof payload.taskIndex === 'number' ? payload.taskIndex : '?';
      return TUI_TEXT.studioProgressTaskStarted(taskIndex, petId);
    }
    case 'task_status_changed': {
      const taskIndex = typeof payload.taskIndex === 'number' ? payload.taskIndex : '?';
      const status = typeof payload.status === 'string' ? payload.status : '?';
      return TUI_TEXT.studioProgressTaskStatusChanged(taskIndex, status);
    }
    case 'wiki_updated': {
      const changed = Array.isArray(payload.changedPaths) ? payload.changedPaths : [];
      return TUI_TEXT.studioProgressWikiUpdated(changed.length);
    }
    case 'task_finished': {
      const petRunId = typeof payload.petRunId === 'string' ? payload.petRunId : '?';
      const status = typeof payload.status === 'string' ? payload.status : '?';
      return TUI_TEXT.studioProgressTaskFinished(petRunId, status);
    }
    default:
      return TUI_TEXT.studioProgressUnknown(type);
  }
}

export function buildBusyStatusLine(
  pending: PendingUiState,
  now: number,
  spinnerFrame: string,
  activeOperations: ActiveOperation[],
) {
  const phase = buildBusyPhaseLabel(pending, now);
  const elapsed = formatElapsed(pending.startedAt, now);
  const detail = pending.charCount > 0 ? ` · ${TUI_TEXT.modelOutputChars(pending.charCount)}` : '';
  const operations = activeOperations.length > 0
    ? ` · ${activeOperations.map((operation) => operation.name).join(', ')}`
    : '';
  return `${spinnerFrame} ${phase} · ${elapsed}${detail}${operations}`;
}

export function buildActiveOperationLines(activeOperations: ActiveOperation[], now: number, width: number) {
  return activeOperations.flatMap((operation, index) =>
    wrapLine(
      `${operation.label} · ${formatElapsed(operation.startedAt, now)}${operation.detail ? ` · ${operation.detail}` : ''}`,
      width,
    ).map((text, lineIndex) => ({
      id: `operation-${operation.name}-${index}-${lineIndex}`,
      text,
    })),
  );
}

function buildBusyPhaseLabel(pending: PendingUiState, now: number) {
  if (pending.phase === 'interrupting') return TUI_TEXT.busyPhaseInterrupting;
  if (pending.phase === 'replying') return TUI_TEXT.busyPhaseReplying;
  const elapsedMs = now - pending.startedAt;
  if (elapsedMs < 3000) return TUI_TEXT.busyPhaseThinking;
  if (elapsedMs < 10000) return TUI_TEXT.busyPhaseUsingTools;
  return TUI_TEXT.busyPhaseLongRunning;
}

function formatOperationDetail(event: LocalAgentOperationEvent, max = 60) {
  const pieces = [
    event.operation.target,
    event.operation.summary,
    formatDetails(event.operation.details),
  ].filter((item): item is string => Boolean(item));
  return pieces.length > 0 ? shorten(pieces.join(' · '), max) : '';
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

function formatSubagentTextBody(text: string) {
  const normalized = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) return '';

  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => splitLongParagraph(paragraph.trim()).join('\n'))
    .filter(Boolean)
    .join('\n\n');
}

function splitLongParagraph(paragraph: string) {
  const sentences = paragraph.match(/[^。！？!?]+[。！？!?]?/g) ?? [paragraph];
  const lines: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    const item = sentence.trim();
    if (!item) continue;
    if (current && current.length + item.length > SUBAGENT_TEXT_LINE_CHARS) {
      lines.push(current);
      current = item;
      continue;
    }
    current = current ? `${current}${item}` : item;
  }
  if (current) lines.push(current);
  return lines;
}
