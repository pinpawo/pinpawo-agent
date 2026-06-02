import type {
  LocalAgentOperationEvent,
  LocalAgentSystemNoticeEvent,
  LocalAgentStudioProgressEvent,
} from '../../events/localAgentEvent';
import { TUI_TEXT } from './text';
import { formatElapsed, wrapLine } from './terminalText';
import type { ActiveOperation, PendingUiState } from '../types';

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
    return `${label}：${TUI_TEXT.operationFailed}${event.operation.summary ? ` · ${shorten(event.operation.summary, 80)}` : ''}`;
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

export function formatStudioProgressEvent(event: LocalAgentStudioProgressEvent): string | null {
  const payload = event.event;
  const type = typeof payload.type === 'string' ? payload.type : null;
  if (!type) return null;
  switch (type) {
    case 'turn_started':
    case 'turn_finished':
      return null;
    case 'plan_set': {
      const plan = payload.plan && typeof payload.plan === 'object'
        ? payload.plan as Record<string, unknown>
        : null;
      const tasks = plan && Array.isArray(plan.tasks) ? plan.tasks : [];
      return TUI_TEXT.studioProgressPlanSet(tasks.length);
    }
    case 'dispatch_started': {
      const petId = typeof payload.petId === 'string' ? payload.petId : '?';
      const taskIndex = typeof payload.taskIndex === 'number' ? payload.taskIndex : '?';
      return TUI_TEXT.studioProgressDispatchStarted(taskIndex, petId);
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
    case 'dispatch_finished': {
      const dispatchId = typeof payload.dispatchId === 'string' ? payload.dispatchId : '?';
      const status = typeof payload.status === 'string' ? payload.status : '?';
      return TUI_TEXT.studioProgressDispatchFinished(dispatchId, status);
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
