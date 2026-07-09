import type { OrchestratorStateType } from '../../state';
import { decisionModeFromRunNextDelegation } from '../decisions/delegationLifecycle';

export function afterDelegationOutcomeDecision(state: OrchestratorStateType) {
  const decisionMode = decisionModeFromRunNextDelegation(state.runNextDelegation);
  if (decisionMode === 'capability') return 'capability';
  if (decisionMode === 'general') return 'general';
  if (state.runPendingFinalReply === 'answer') return 'answer';
  if (state.runPendingFinalReply === 'inline') return 'finalizeRun';
  // A verdict-only task_done clears the active task but intentionally leaves
  // planning to the next taskDecision pass.
  if (!state.taskActiveDelegation && !state.runPendingTask && !state.runNextDelegation) {
    return 'taskDecision';
  }
  return 'end';
}
