import type { OrchestratorStateType } from '../../state';
import type {
  DecisionMode,
  MessageLane,
  RunNextDelegation,
  TaskActiveDelegation,
  UserGoal,
} from '../../types';

export function decisionModeFromRunNextDelegation(pending: RunNextDelegation | null): DecisionMode {
  return pending ? 'capability' : 'answer';
}

export function createTaskActiveDelegation(
  delegation: RunNextDelegation,
  runId: string,
  userGoal: UserGoal,
  traceId?: string,
): TaskActiveDelegation {
  return {
    id: delegation.id,
    lane: delegation.lane,
    task: delegation.task,
    contextSummary: delegation.contextSummary,
    transcriptRunId: runId,
    ...(traceId ? { traceId } : {}),
    status: 'pending',
    resultPreview: null,
    userGoal,
  };
}

export function resolveDelegationTranscriptRunId(
  state: OrchestratorStateType,
  delegation: RunNextDelegation,
) {
  return state.taskActiveDelegation?.id === delegation.id
    ? state.taskActiveDelegation.transcriptRunId
    : state.runId;
}

export function readCapabilityNameFromLane(lane: MessageLane): string | null {
  return lane.startsWith('capability:') ? lane.slice('capability:'.length) : null;
}
