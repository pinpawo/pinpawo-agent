import type {
  TuiCoreOperationTimelineEntry,
  TuiCoreRuntimeSnapshot,
  TuiCoreSessionSnapshot,
  TuiCoreTimelineEntry,
} from '../contracts/tuiCoreContract';
import {
  timelineEntryIdFromHistoryCell,
  type AgentOperationEntry,
  type AgentTimelineEntry,
} from '../timeline/agentTimeline';
import type {
  HistoryCellModel,
  SessionModel,
  TokenUsageModel,
} from '../state/tuiState';

type BuildSnapshotFromMessagesParams = {
  sessionId: string;
  kind: TuiCoreSessionSnapshot['kind'];
  messages: HistoryCellModel[];
  runtime?: Partial<SessionModel['runtime']> | null;
  tokenUsage?: TokenUsageModel | null;
};

export function buildTuiSessionSnapshotFromMessages(
  params: BuildSnapshotFromMessagesParams,
): TuiCoreSessionSnapshot {
  return {
    sessionId: params.sessionId,
    kind: params.kind,
    timeline: timelineSnapshotFromMessages(params.messages),
    runs: [],
    ...(params.runtime ? { runtime: normalizeRuntimeSnapshot(params.runtime) } : {}),
    ...(params.tokenUsage ? { tokenUsage: params.tokenUsage } : {}),
  };
}

export function timelineSnapshotFromMessages(messages: HistoryCellModel[]): TuiCoreTimelineEntry[] {
  return messages.flatMap((cell) => {
    if (cell.kind !== 'user' && cell.kind !== 'assistant') return [];
    return [{
      id: timelineEntryIdFromHistoryCell(cell),
      type: 'message',
      role: cell.kind,
      text: cell.text,
      status: 'completed',
      source: 'checkpoint',
      ...(cell.timestamp ? { createdAt: cell.timestamp } : {}),
    } satisfies TuiCoreTimelineEntry];
  });
}

export function agentTimelineEntriesFromSnapshot(timeline: TuiCoreTimelineEntry[]): AgentTimelineEntry[] {
  return timeline.map((entry) => {
    if (entry.type === 'message') {
      return {
        id: entry.id,
        type: 'message',
        role: entry.role,
        text: entry.text,
        status: entry.status,
        ...(entry.requestId ? { requestId: entry.requestId } : {}),
        ...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
        ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
      } satisfies AgentTimelineEntry;
    }
    return operationEntryFromSnapshot(entry);
  });
}

function operationEntryFromSnapshot(entry: TuiCoreOperationTimelineEntry): AgentOperationEntry {
  return {
    id: entry.id,
    type: 'operation',
    requestId: entry.requestId,
    operationKey: entry.operationKey,
    kind: entry.operationKey,
    title: entry.title ?? entry.operationKey,
    phase: entry.phase,
    summary: entry.summary,
    startedAt: entry.startedAt ?? entry.updatedAt ?? 0,
    updatedAt: entry.updatedAt ?? entry.startedAt ?? 0,
    ...(entry.completedAt !== undefined ? { completedAt: entry.completedAt } : {}),
  };
}

function normalizeRuntimeSnapshot(
  runtime: Partial<SessionModel['runtime']>,
): TuiCoreRuntimeSnapshot {
  return {
    ...(runtime.model ? { model: runtime.model } : {}),
    ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
    ...(runtime.stateRoot ? { stateRoot: runtime.stateRoot } : {}),
    ...(runtime.studioConfigPath ? { studioConfigPath: runtime.studioConfigPath } : {}),
    ...(runtime.studioConfigSource ? { studioConfigSource: runtime.studioConfigSource } : {}),
    ...(runtime.studioConfigActivePath ? { studioConfigActivePath: runtime.studioConfigActivePath } : {}),
    ...(runtime.legacyStudioConfigPath ? { legacyStudioConfigPath: runtime.legacyStudioConfigPath } : {}),
    ...(runtime.petsDir ? { petsDir: runtime.petsDir } : {}),
    ...(runtime.studioWikiBaseDir ? { studioWikiBaseDir: runtime.studioWikiBaseDir } : {}),
    ...(runtime.contextWindow !== undefined ? { contextWindow: runtime.contextWindow } : {}),
  };
}
