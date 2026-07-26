import type { OrchestratorStateType } from '../../state';
import { decisionModeFromRunNextDelegation } from '../decisions/delegationLifecycle';

export function afterDecision(state: OrchestratorStateType) {
  const decisionMode = decisionModeFromRunNextDelegation(state.runNextDelegation);
  return decisionMode;
}
