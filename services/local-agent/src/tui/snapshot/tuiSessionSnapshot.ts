import type {
  LocalAgentRuntimeView,
  LocalAgentSession,
  LocalAgentSessionSnapshot,
  LocalAgentTimelineEntry,
} from '../../localAgentSession';
import { LOCAL_AGENT_SESSION_SNAPSHOT_VERSION } from '../../localAgentSession';
import {
  timelineEntryIdFromMessageCell,
  type AgentTimelineEntry,
} from '../timeline/agentTimeline';
import type {
  MessageCellModel,
  SessionModel,
  TokenUsageModel,
} from '../state/tuiState';

type BuildSnapshotFromMessagesParams = {
  sessionId: string;
  kind: LocalAgentSession['kind'];
  messages: MessageCellModel[];
  runtime?: Partial<SessionModel['runtime']> | null;
  tokenUsage?: TokenUsageModel | null;
};

export function buildTuiSessionSnapshotFromMessages(
  params: BuildSnapshotFromMessagesParams,
): LocalAgentSessionSnapshot {
  return {
    version: LOCAL_AGENT_SESSION_SNAPSHOT_VERSION,
    session: {
      sessionId: params.sessionId,
      kind: params.kind,
      timeline: timelineSnapshotFromMessages(params.messages),
      activeRun: null,
      ...(params.runtime ? { runtime: normalizeRuntimeSnapshot(params.runtime) } : {}),
      ...(params.tokenUsage ? { tokenUsage: params.tokenUsage } : {}),
    },
  };
}

export function timelineSnapshotFromMessages(messages: MessageCellModel[]): LocalAgentTimelineEntry[] {
  return messages.flatMap((cell) => {
    if (cell.kind !== 'user' && cell.kind !== 'assistant') return [];
    return [{
      id: timelineEntryIdFromMessageCell(cell),
      type: 'message',
      role: cell.kind,
      text: cell.text,
      status: 'completed',
      source: 'checkpoint',
      ...(cell.requestId ? { requestId: cell.requestId } : {}),
      ...(cell.timestamp ? { createdAt: cell.timestamp } : {}),
    } satisfies LocalAgentTimelineEntry];
  });
}

export function agentTimelineEntriesFromSnapshot(timeline: LocalAgentTimelineEntry[]): AgentTimelineEntry[] {
  return timeline.map((entry) => ({ ...entry }));
}

function normalizeRuntimeSnapshot(
  runtime: Partial<SessionModel['runtime']>,
): LocalAgentRuntimeView {
  return {
    ...(runtime.model ? { model: runtime.model } : {}),
    ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
    ...(runtime.stateRoot ? { stateRoot: runtime.stateRoot } : {}),
    ...(runtime.studioConfigPath ? { studioConfigPath: runtime.studioConfigPath } : {}),
    ...(runtime.studioDueRunsPath ? { studioDueRunsPath: runtime.studioDueRunsPath } : {}),
    ...(runtime.studioConfigSource ? { studioConfigSource: runtime.studioConfigSource } : {}),
    ...(runtime.studioConfigActivePath ? { studioConfigActivePath: runtime.studioConfigActivePath } : {}),
    ...(runtime.legacyStudioConfigPath ? { legacyStudioConfigPath: runtime.legacyStudioConfigPath } : {}),
    ...(runtime.petsDir ? { petsDir: runtime.petsDir } : {}),
    ...(runtime.studioWikiBaseDir ? { studioWikiBaseDir: runtime.studioWikiBaseDir } : {}),
    ...(runtime.contextWindow !== undefined ? { contextWindow: runtime.contextWindow } : {}),
  };
}
