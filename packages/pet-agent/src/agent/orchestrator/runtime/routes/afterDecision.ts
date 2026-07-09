import type { OrchestratorStateType } from '../../state';
import { decisionModeFromRunNextDelegation } from '../decisions/delegationLifecycle';

export function afterDecision(state: OrchestratorStateType) {
  const decisionMode = decisionModeFromRunNextDelegation(state.runNextDelegation);
  if (decisionMode === 'capability') return 'capability';
  if (decisionMode === 'general') return 'general';
  if (state.runPendingFinalReply === 'answer') return 'answer';
  if (state.runPendingFinalReply === 'inline') return 'finalizeRun';
  return 'end';
}
