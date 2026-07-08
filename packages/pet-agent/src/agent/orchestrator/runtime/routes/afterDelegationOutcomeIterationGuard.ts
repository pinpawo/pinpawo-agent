import type { OrchestratorStateType } from '../../state';

export function afterDelegationOutcomeIterationGuard(state: OrchestratorStateType) {
  return state.runPendingFinalReply === 'inline' ? 'end' : 'delegationOutcomeDecision';
}
