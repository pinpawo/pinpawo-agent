import type { OrchestratorStateType } from '../../state';

export function afterContextPrep(state: OrchestratorStateType) {
  if (state.taskActiveDelegation?.status === 'awaiting_decision') {
    return 'delegationOutcomeIterationGuard';
  }
  return 'entryDecision';
}
