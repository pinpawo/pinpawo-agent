import type { OrchestratorStateType } from '../../state';
import type {
  DecisionMode,
  MessageLane,
  RunNextDelegation,
  TaskActiveDelegation,
  UserRequest,
} from '../../types';

export function decisionModeFromRunNextDelegation(pending: RunNextDelegation | null): DecisionMode {
  return pending ? 'capability' : 'answer';
}

export function createTaskActiveDelegation(
  delegation: RunNextDelegation,
  runId: string,
  userRequest: UserRequest,
  traceId: string,
): TaskActiveDelegation {
  return {
    id: delegation.id,
    lane: delegation.lane,
    task: delegation.task,
    contextSummary: delegation.contextSummary,
    transcriptRunId: runId,
    traceId,
    status: 'pending',
    resultPreview: null,
    userRequest,
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
