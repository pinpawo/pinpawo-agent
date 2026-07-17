import type {
  LocalAgentRunView,
  LocalAgentRuntimeView,
  LocalAgentSession,
  LocalAgentSessionSnapshot,
  LocalAgentTimelineEntry,
} from './localAgentSession';
import { LOCAL_AGENT_SESSION_SNAPSHOT_VERSION } from './localAgentSession';
import type { ReviewActionSnapshot } from './localServerChatHandler';
import type { LocalServerDeps } from './localServerTypes';
import type { TuiCheckpointMessage } from './localServerTuiSessions';
import { buildLocalRuntimeProjection } from './localConfigProjection';

export function buildLocalAgentSessionSnapshot(params: {
  sessionId: string;
  kind: LocalAgentSession['kind'];
  messages: TuiCheckpointMessage[];
  deps: LocalServerDeps;
  pendingReview?: ReviewActionSnapshot | null;
}): LocalAgentSessionSnapshot {
  const timeline = timelineFromCheckpointMessages(params.messages);
  const pendingReview = params.pendingReview ?? null;
  return {
    version: LOCAL_AGENT_SESSION_SNAPSHOT_VERSION,
    session: {
      sessionId: params.sessionId,
      kind: params.kind,
      timeline,
      activeRun: pendingReview
        ? runFromPendingReview({
          pendingReview,
        })
        : null,
      runtime: buildLocalAgentRuntimeView(params.deps),
    },
  };
}

export function buildLocalAgentRuntimeView(
  deps: LocalServerDeps,
): LocalAgentRuntimeView {
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

function timelineFromCheckpointMessages(messages: TuiCheckpointMessage[]): LocalAgentTimelineEntry[] {
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
    } satisfies LocalAgentTimelineEntry];
  });
}

function runFromPendingReview(params: {
  pendingReview: ReviewActionSnapshot;
}): LocalAgentRunView {
  const petId = params.pendingReview.actor?.petId;
  return {
    requestId: params.pendingReview.requestId,
    state: 'waiting_review',
    reviewAction: {
      ...params.pendingReview.reviewAction,
      ...(petId ? { petId } : {}),
    },
  };
}
