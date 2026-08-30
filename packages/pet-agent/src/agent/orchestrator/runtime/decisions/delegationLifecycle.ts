import type { OrchestratorStateType } from '../../state';
import type {
  DecisionMode,
  CapabilityMessageLane,
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
    runId,
    traceId,
    status: 'pending',
    resultPreview: null,
    userRequest,
  };
}

export function resolveDelegationRunId(
  state: OrchestratorStateType,
  delegation: RunNextDelegation,
) {
  return state.taskActiveDelegation?.id === delegation.id
    ? state.taskActiveDelegation.runId
    : state.runId;
}

export function readCapabilityNameFromLane(lane: CapabilityMessageLane): string | null {
  return lane.startsWith('capability:') ? lane.slice('capability:'.length) : null;
}
