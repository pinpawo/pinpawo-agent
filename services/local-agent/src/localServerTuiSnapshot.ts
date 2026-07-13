import type {
  TuiCoreRuntimeSnapshot,
  TuiCoreSessionSnapshot,
  TuiCoreTimelineEntry,
} from './tui/contracts/tuiCoreContract';
import type { ReviewActionSnapshot } from './localServerChatHandler';
import type { LocalServerDeps } from './localServerTypes';
import type { TuiHistoryMessage } from './localServerTuiSessions';
import { buildLocalRuntimeProjection } from './localConfigProjection';

export function buildLocalServerTuiSnapshot(params: {
  sessionId: string;
  kind: TuiCoreSessionSnapshot['kind'];
  messages: TuiHistoryMessage[];
  deps: LocalServerDeps;
  pendingReview?: ReviewActionSnapshot | null;
}): TuiCoreSessionSnapshot {
  const timeline = timelineFromHistoryMessages(params.messages);
  const pendingReview = params.pendingReview ?? null;
  return {
    sessionId: params.sessionId,
    kind: params.kind,
    timeline,
    runs: pendingReview
      ? [runFromPendingReview({
          pendingReview,
          sessionId: params.sessionId,
          kind: params.kind,
          timeline,
        })]
      : [],
    ...(pendingReview ? {
      activeRunId: pendingReview.requestId,
    } : {}),
    runtime: buildLocalServerTuiRuntimeSnapshot(params.deps),
  };
}

export function buildLocalServerTuiRuntimeSnapshot(
  deps: LocalServerDeps,
): TuiCoreRuntimeSnapshot {
  const runtime = buildLocalRuntimeProjection(deps);
  return {
    model: runtime.model,
    ...(runtime.contextWindow !== undefined ? { contextWindow: runtime.contextWindow } : {}),
    cwd: runtime.workdir,
    ...(runtime.workspaceId ? { workspaceId: runtime.workspaceId } : {}),
    ...(runtime.workspaceName ? { workspaceName: runtime.workspaceName } : {}),
    ...(runtime.workspaceRoot ? { workspaceRoot: runtime.workspaceRoot } : {}),
    ...(runtime.stateRoot ? { stateRoot: runtime.stateRoot } : {}),
    ...(runtime.studioConfigPath ? { studioConfigPath: runtime.studioConfigPath } : {}),
    ...(runtime.studioDueRunsPath ? { studioDueRunsPath: runtime.studioDueRunsPath } : {}),
    ...(runtime.petsDir ? { petsDir: runtime.petsDir } : {}),
    ...(runtime.studioWikiBaseDir ? { studioWikiBaseDir: runtime.studioWikiBaseDir } : {}),
    studioConfigSource: runtime.studioConfigSource,
    studioConfigActivePath: runtime.studioConfigActivePath,
    legacyStudioConfigPath: runtime.legacyStudioConfigPath,
  };
}

function timelineFromHistoryMessages(messages: TuiHistoryMessage[]): TuiCoreTimelineEntry[] {
  return messages.flatMap((message, index) => {
    if (message.role !== 'user' && message.role !== 'assistant') {
      return [];
    }
    const text = message.text.trim();
    if (!text) {
      return [];
    }
    return [{
      id: `message:${index}:${message.role}`,
      type: 'message',
      role: message.role,
      text,
      status: 'completed',
      source: 'checkpoint',
      ...(message.createdAt ? { createdAt: message.createdAt } : {}),
    } satisfies TuiCoreTimelineEntry];
  });
}

function runFromPendingReview(params: {
  pendingReview: ReviewActionSnapshot;
  sessionId: string;
  kind: TuiCoreSessionSnapshot['kind'];
  timeline: TuiCoreTimelineEntry[];
}): TuiCoreSessionSnapshot['runs'][number] {
  const petId = params.pendingReview.actor?.petId;
  return {
    requestId: params.pendingReview.requestId,
    sessionId: params.pendingReview.sessionId ?? params.sessionId,
    kind: params.kind,
    phase: 'waiting_human',
    timelineEntryIds: params.timeline.map((entry) => entry.id),
    reviewAction: {
      ...params.pendingReview.reviewAction,
      ...(petId ? { petId } : {}),
    },
  };
}
