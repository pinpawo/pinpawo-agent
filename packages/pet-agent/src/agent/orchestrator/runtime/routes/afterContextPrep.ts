import { hasRunHumanMessage } from '../../conversationMessages';
import type { OrchestratorStateType } from '../../state';

export function afterContextPrep(state: OrchestratorStateType) {
  if (
    state.runActiveDelegationTransition === 'resume_active'
    && state.taskActiveDelegation
    && (state.taskActiveDelegation.status === 'awaiting_decision'
      || hasRunHumanMessage(state.messages, state.runId))
  ) {
    return 'supervisorBoundaryIterationGuard';
  }
  if (
    state.runActiveDelegationTransition === 'resume_active'
    && state.taskActiveDelegation?.status === 'pending'
    && state.runNextDelegation?.id === state.taskActiveDelegation.id
  ) {
    return 'runSupervisor';
  }
  if (state.runActiveDelegationTransition === 'resume_active' && state.taskRunContinuation
    && !state.taskActiveDelegation) return 'runSupervisor';
  return 'captureUserRequest';
}
