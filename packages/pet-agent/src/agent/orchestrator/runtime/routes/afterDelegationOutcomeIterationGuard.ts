import type { OrchestratorStateType } from '../../state';

export function afterDelegationOutcomeIterationGuard(state: OrchestratorStateType) {
  if (state.runStopReason) return 'end';
  return state.runPendingFinalReply === 'inline' ? 'end' : 'delegationOutcomeDecisionGuard';
}
