import type {
  AgentInputModality,
  AgentPlan,
  AgentRunView,
  AgentRuntimeView,
  AgentSession,
  AgentSessionSnapshot,
  AgentTimelineEntry,
} from '@pinpawo/agent-session';
import { createAgentSessionSnapshot } from '@pinpawo/agent-session';
import type { PendingInterruptSnapshot } from './localServerChatHandler';
import type { LocalServerDeps } from './localServerTypes';
import type { TuiCheckpointMessage } from './localServerTuiSessions';
import { buildLocalRuntimeProjection } from './localConfigProjection';
import {
  missingInputModalities,
  supportsInputModalities,
} from './modelProfiles';

export function buildLocalAgentSessionSnapshot(params: {
  sessionId: string;
  kind: AgentSession['kind'];
  messages: TuiCheckpointMessage[];
  deps: LocalServerDeps;
  modelProfileId?: string;
  requiredInputModalities?: readonly AgentInputModality[];
  sessionTokenUsage?: AgentSession['sessionTokenUsage'] | null;
  pendingInterrupt?: PendingInterruptSnapshot | null;
  /** Live local transport state; never inferred from checkpoint plan data. */
  activeRun?: Extract<AgentRunView, { state: 'running' }> | null;
  currentPlan?: AgentPlan | null;
}): AgentSessionSnapshot {
  const timeline = timelineFromCheckpointMessages(params.messages);
  const pendingInterrupt = params.pendingInterrupt ?? null;
  const runtime = buildLocalAgentRuntimeView(
    params.deps,
    params.modelProfileId,
    params.requiredInputModalities,
  );
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
    activeRun: params.activeRun ?? null,
    pendingInterrupt: pendingInterrupt?.pendingInterrupt ?? null,
    ...(params.currentPlan !== undefined ? { currentPlan: params.currentPlan } : {}),
    runtime,
    ...(sessionTokenUsage ? { sessionTokenUsage } : {}),
  });
}

export function buildLocalAgentRuntimeView(
  deps: LocalServerDeps,
  modelProfileId = deps.modelProfiles.defaultProfileId,
  requiredInputModalities: readonly AgentInputModality[] = ['text'],
): AgentRuntimeView {
  const runtime = buildLocalRuntimeProjection(deps, modelProfileId);
  const supportedInputModalities = runtime.inputModalities ?? ['text'];
  const modelProfileCompatible = runtime.modelProfileAvailable
    && supportsInputModalities(
      requiredInputModalities,
      supportedInputModalities,
    );
  const compatibilityIssues = modelProfileCompatible
    ? []
    : runtime.modelProfileAvailable
      ? [
          `Session input is incompatible with this model profile: missing ${
            missingInputModalities(
              requiredInputModalities,
              supportedInputModalities,
            ).join(', ')
          }`,
        ]
      : [];
  return {
    modelProfileId: runtime.modelProfileId,
    modelProfileLabel: runtime.modelProfileLabel,
    modelProfileAvailable: runtime.modelProfileAvailable,
    modelProfileCompatible,
    modelProfileIssues: [
      ...runtime.modelProfileIssues,
      ...compatibilityIssues,
    ],
    ...(runtime.model ? { model: runtime.model } : {}),
    ...(runtime.inputModalities ? {
      inputModalities: runtime.inputModalities.map((modality) => (
        modality === 'image' ? 'image' as const : 'text' as const
      )),
    } : {}),
    requiredInputModalities: [...requiredInputModalities],
    globalReviewPolicyMode: runtime.globalReviewPolicyMode,
    autoAuthorizationSafetyLevel: runtime.autoAuthorizationSafetyLevel,
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
      ...(message.role === 'subagent'
        ? { requestId: message.requestId }
        : {}),
      ...(message.createdAt ? { createdAt: message.createdAt } : {}),
    } satisfies AgentTimelineEntry];
  });
}
