import type { ActiveOperation } from '../types';
import {
  isRunningOperationPhase,
  type AgentOperationEntry,
  type AgentTimelineEntry,
} from './agentTimeline';

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
    startedAt: entry.startedAt,
  }));
}

export function findTimelineOperationEntry(
  entries: AgentTimelineEntry[],
  operationId: string,
): AgentOperationEntry | null {
  return selectOperationTimelineEntries(entries).find((entry) =>
    entry.id === operationId || entry.operationKey === operationId) ?? null;
}

export function splitTimelineForStaticRender(entries: AgentTimelineEntry[]): {
  staticEntries: AgentTimelineEntry[];
  dynamicEntries: AgentTimelineEntry[];
} {
  const firstDynamicIndex = entries.findIndex((entry) => !isSettledTimelineEntry(entry));
  if (firstDynamicIndex < 0) {
    return {
      staticEntries: entries,
      dynamicEntries: [],
    };
  }
  return {
    staticEntries: entries.slice(0, firstDynamicIndex),
    dynamicEntries: entries.slice(firstDynamicIndex),
  };
}

function isSettledTimelineEntry(entry: AgentTimelineEntry) {
  switch (entry.type) {
    case 'message':
      return entry.status === 'completed';
    case 'operation':
      return !isRunningOperationPhase(entry.phase);
  }
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
      if (value === undefined || value === null || value === '') return [];
      return [`${key}=${String(value)}`];
    })
    .join(' · ');
}
