import type { ActiveOperation } from '../types';
import {
  isRunningOperationPhase,
  type AgentOperationEntry,
  type AgentTimelineEntry,
} from './agentTimeline';

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

export type AgentTimelineDisplayEntry = {
  type: 'timeline';
  id: string;
  entry: AgentTimelineEntry;
};

export type AgentTimelineViewportModel = {
  entries: AgentTimelineDisplayEntry[];
  staticEntries: AgentTimelineDisplayEntry[];
  dynamicEntries: AgentTimelineDisplayEntry[];
};

export function buildTimelineViewportModel(
  entries: AgentTimelineEntry[],
): AgentTimelineViewportModel {
  const displayEntries = buildTimelineDisplayEntries(entries);
  return {
    entries: displayEntries,
    ...splitTimelineDisplayForViewport(displayEntries),
  };
}

export function buildTimelineDisplayEntries(
  entries: AgentTimelineEntry[],
): AgentTimelineDisplayEntry[] {
  return entries.map((entry) => ({ type: 'timeline', id: entry.id, entry }));
}

export function splitTimelineDisplayForViewport(
  displayEntries: AgentTimelineDisplayEntry[],
): {
  staticEntries: AgentTimelineDisplayEntry[];
  dynamicEntries: AgentTimelineDisplayEntry[];
} {
  const firstDynamicIndex = displayEntries.findIndex((entry) => !isSettledDisplayEntry(entry));
  if (firstDynamicIndex < 0) {
    return {
      staticEntries: displayEntries,
      dynamicEntries: [],
    };
  }
  return {
    staticEntries: displayEntries.slice(0, firstDynamicIndex),
    dynamicEntries: displayEntries.slice(firstDynamicIndex),
  };
}

function isSettledDisplayEntry(entry: AgentTimelineDisplayEntry) {
  return isSettledTimelineEntry(entry.entry);
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
      if (OPERATION_PAYLOAD_DETAIL_KEYS.has(key)) return [];
      if (value === undefined || value === null || value === '') return [];
      return [`${key}=${String(value)}`];
    })
    .join(' · ');
}
