import type { ActiveOperation } from '../types';
import { isRunningOperationPhase } from '../../localAgentTimeline';
import type {
  LocalAgentOperationEntry,
  LocalAgentTimelineEntry,
} from '../../localAgentSession';

const OPERATION_PAYLOAD_DETAIL_KEYS = new Set([
  'after',
  'afterPreview',
  'before',
  'files',
  'patch',
]);

export function selectOperationTimelineEntries(
  entries: LocalAgentTimelineEntry[],
): LocalAgentOperationEntry[] {
  return entries.filter((entry): entry is LocalAgentOperationEntry => entry.type === 'operation');
}

export function selectRunningOperationEntries(
  entries: LocalAgentTimelineEntry[],
  requestId?: string,
): LocalAgentOperationEntry[] {
  return selectOperationTimelineEntries(entries).filter((entry) =>
    isRunningOperationPhase(entry.phase)
      && (requestId === undefined || entry.requestId === requestId));
}

export function selectActiveOperationsFromTimeline(
  entries: LocalAgentTimelineEntry[],
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
  entries: LocalAgentTimelineEntry[],
  operationId: string,
): LocalAgentOperationEntry | null {
  return selectOperationTimelineEntries(entries).find((entry) =>
    entry.id === operationId || entry.operationKey === operationId) ?? null;
}

function formatOperationTimelineDetail(entry: LocalAgentOperationEntry) {
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
