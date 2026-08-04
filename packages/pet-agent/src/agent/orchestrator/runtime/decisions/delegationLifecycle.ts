import type { OrchestratorStateType } from '../../state';
import type {
  DecisionMode,
  MessageLane,
  RunNextDelegation,
  TaskActiveDelegation,
} from '../../types';

/**
 * Presentation-only activity emitted through the runtime event stream. It is
 * deliberately separate from the delegation state machine: consumers may
 * render progress, but cannot derive or change orchestration decisions from
 * this advisory event.
 */
export const DELEGATION_RUNTIME_EVENT = 'delegation_activity';

export type DelegationRuntimeActivity = {
  delegationId: string;
  capability: string;
  task: string;
  state: 'started' | 'handed_off' | 'waiting_for_input' | 'interrupted' | 'failed';
};

export function delegationRuntimeActivityEvent(activity: DelegationRuntimeActivity) {
  return {
    event: 'on_runtime_event' as const,
    name: DELEGATION_RUNTIME_EVENT,
    data: activity,
  };
}

export function decisionModeFromRunNextDelegation(pending: RunNextDelegation | null): DecisionMode {
  return pending ? 'capability' : 'answer';
}

export function createTaskActiveDelegation(
  delegation: RunNextDelegation,
  runId: string,
): TaskActiveDelegation {
  return {
    id: delegation.id,
    lane: delegation.lane,
    task: delegation.task,
    contextSummary: delegation.contextSummary,
    transcriptRunId: runId,
    status: 'pending',
    resultPreview: null,
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
