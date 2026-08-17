import type { OrchestratorStateType } from '../../state';

export function afterContextPrep(state: OrchestratorStateType) {
  if (
    state.runActiveDelegationTransition === 'resume_active'
    && state.taskActiveDelegation?.status === 'awaiting_decision'
  ) {
    return 'plannerBoundaryIterationGuard';
  }
  if (
    state.runActiveDelegationTransition === 'resume_active'
    && state.taskActiveDelegation?.status === 'pending'
    && state.runNextDelegation?.id === state.taskActiveDelegation.id
  ) {
    return 'capability';
  }
  return 'captureUserRequest';
}
