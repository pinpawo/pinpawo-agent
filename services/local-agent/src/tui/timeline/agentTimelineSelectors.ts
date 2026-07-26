import type { ActiveOperation } from '../types';
import { isRunningOperationPhase } from '@pinpawo/agent-session';
import type {
  AgentOperationEntry,
  AgentTimelineEntry,
} from '@pinpawo/agent-session';

const OPERATION_PAYLOAD_DETAIL_KEYS = new Set([
  'after',
  'afterPreview',
  'before',
  'files',
  'patch',
]);

export function selectOperationTimelineEntries(
  entries: AgentTimelineEntry[],
): AgentOperationEntry[] {
  return entries.filter((entry): entry is AgentOperationEntry => entry.type === 'operation');
}

export function selectRunningOperationEntries(
  entries: AgentTimelineEntry[],
  requestId?: string,
): AgentOperationEntry[] {
  return selectOperationTimelineEntries(entries).filter((entry) =>
    isRunningOperationPhase(entry.phase)
      && (requestId === undefined || entry.requestId === requestId));
}

export function selectActiveOperationsFromTimeline(
  entries: AgentTimelineEntry[],
  requestId?: string,
): ActiveOperation[] {
  return selectRunningOperationEntries(entries, requestId).map((entry) => ({
    name: entry.operationKey,
    label: entry.title,
    detail: formatOperationTimelineDetail(entry),
    startedAt: entry.startedAt ?? entry.updatedAt ?? 0,
  }));
}

export function findTimelineOperationEntry(
  entries: AgentTimelineEntry[],
  operationId: string,
): AgentOperationEntry | null {
  return selectOperationTimelineEntries(entries).find((entry) =>
    entry.id === operationId || entry.operationKey === operationId) ?? null;
}

function formatOperationTimelineDetail(entry: AgentOperationEntry) {
  const details = formatDetails(entry.details);
  return [entry.target, entry.summary, details]
    .filter((item): item is string => Boolean(item))
    .join(' · ');
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
