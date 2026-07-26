import type {
  AgentRunView,
  AgentRuntimeView,
  AgentSession,
  AgentSessionSnapshot,
  AgentTimelineEntry,
} from '@pinpawo/agent-session';
import { createAgentSessionSnapshot } from '@pinpawo/agent-session';
import type { ReviewActionSnapshot } from './localServerChatHandler';
import type { LocalServerDeps } from './localServerTypes';
import type { TuiCheckpointMessage } from './localServerTuiSessions';
import { buildLocalRuntimeProjection } from './localConfigProjection';

export function buildLocalAgentSessionSnapshot(params: {
  sessionId: string;
  kind: AgentSession['kind'];
  messages: TuiCheckpointMessage[];
  deps: LocalServerDeps;
  sessionTokenUsage?: AgentSession['sessionTokenUsage'] | null;
  pendingReview?: ReviewActionSnapshot | null;
}): AgentSessionSnapshot {
  const timeline = timelineFromCheckpointMessages(params.messages);
  const pendingReview = params.pendingReview ?? null;
  const runtime = buildLocalAgentRuntimeView(params.deps);
  const sessionTokenUsage = params.sessionTokenUsage
    ? {
        ...params.sessionTokenUsage,
        ...(params.sessionTokenUsage.contextWindow === undefined && runtime.contextWindow !== undefined
          ? { contextWindow: runtime.contextWindow }
          : {}),
      }
    : null;
  return createAgentSessionSnapshot({
    sessionId: params.sessionId,
    kind: params.kind,
    timeline,
    activeRun: pendingReview
      ? runFromPendingReview({
        pendingReview,
      })
      : null,
    runtime,
    ...(sessionTokenUsage ? { sessionTokenUsage } : {}),
  });
}

export function buildLocalAgentRuntimeView(
  deps: LocalServerDeps,
): AgentRuntimeView {
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
  };
}

function timelineFromCheckpointMessages(messages: TuiCheckpointMessage[]): AgentTimelineEntry[] {
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
      ...(message.createdAt ? { createdAt: message.createdAt } : {}),
    } satisfies AgentTimelineEntry];
  });
}

function runFromPendingReview(params: {
  pendingReview: ReviewActionSnapshot;
}): AgentRunView {
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
