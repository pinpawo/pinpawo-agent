import type {
  LocalAgentOperationEvent,
  LocalAgentSystemNoticeEvent,
  LocalAgentStudioProgressEvent,
} from '../../events/localAgentEvent';
import { TUI_TEXT } from './text';
import { formatElapsed, wrapLine } from './terminalText';
import type { ActiveOperation, PendingUiState } from '../types';

const SUBAGENT_TEXT_LINE_CHARS = 64;
const OPERATION_DETAIL_LINE_MAX = 140;
const OPERATION_DETAIL_ENTRY_LIMIT = 8;

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
  const headline = formatOperationHeadline(event, 80);
  const details = formatDetailsBlock(event.operation.details);
  const suffix = details.length > 0 ? `\n${details.map((line) => `  - ${line}`).join('\n')}` : '';
  if (event.phase === 'failed') {
    return `${label}：${TUI_TEXT.operationFailed}${headline ? ` · ${headline}` : ''}${suffix}`;
  }
  if (event.phase === 'interrupted') {
    return `${label}：${TUI_TEXT.operationInterrupted}${headline ? ` · ${headline}` : ''}${suffix}`;
  }
  return `${label}：${headline || TUI_TEXT.operationCompleted}${suffix}`;
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
    formatDetailsInline(event.operation.details),
  ].filter((item): item is string => Boolean(item));
  return pieces.length > 0 ? shorten(pieces.join(' · '), max) : '';
}

function formatOperationHeadline(event: LocalAgentOperationEvent, max = 80) {
  const pieces = [
    event.operation.target,
    event.operation.summary,
  ].filter((item): item is string => Boolean(item));
  return pieces.length > 0 ? shorten(pieces.join(' · '), max) : '';
}

function formatDetailsInline(details: Record<string, unknown> | undefined) {
  return readDetailEntries(details)
    .map((entry) => `${entry.key}=${entry.value}`)
    .join(' · ');
}

function formatDetailsBlock(details: Record<string, unknown> | undefined) {
  const entries = readDetailEntries(details);
  const visible = entries.slice(0, OPERATION_DETAIL_ENTRY_LIMIT)
    .map((entry) => `${entry.key}: ${shorten(entry.value, OPERATION_DETAIL_LINE_MAX)}`);
  const hiddenCount = entries.length - visible.length;
  return hiddenCount > 0 ? [...visible, `还有 ${hiddenCount} 项 details`] : visible;
}

function readDetailEntries(details: Record<string, unknown> | undefined) {
  if (!details) return [];
  return Object.entries(details).flatMap(([key, value]) => {
    const formatted = formatDetailValue(value);
    return formatted ? [{ key, value: formatted }] : [];
  });
}

function formatDetailValue(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') return normalizeDetailText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const items = value
      .map((item) => formatDetailValue(item))
      .filter((item): item is string => Boolean(item));
    return items.length > 0 ? items.join(', ') : null;
  }
  if (typeof value === 'object') {
    try {
      return normalizeDetailText(JSON.stringify(value));
    } catch {
      return normalizeDetailText(String(value));
    }
  }
  return normalizeDetailText(String(value));
}

function normalizeDetailText(value: string) {
  return value.replace(/\s+/g, ' ').trim();
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
