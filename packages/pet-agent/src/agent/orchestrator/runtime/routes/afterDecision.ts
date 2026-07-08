import type { OrchestratorStateType } from '../../state';
import { decisionModeFromRunNextDelegation } from '../decisions/delegationLifecycle';

export function afterDecision(state: OrchestratorStateType) {
  const decisionMode = decisionModeFromRunNextDelegation(state.runNextDelegation);
  if (decisionMode === 'capability') return 'capability';
  if (decisionMode === 'general') return 'general';
  // answer bucket: route a real answer decision to the answer node; inline fallback
  // errors already emitted their message.
  return state.runPendingFinalReply === 'answer' ? 'answer' : 'end';
}
