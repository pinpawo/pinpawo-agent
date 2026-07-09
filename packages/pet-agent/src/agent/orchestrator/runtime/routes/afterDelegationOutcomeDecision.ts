import type { OrchestratorStateType } from '../../state';
import { decisionModeFromRunNextDelegation } from '../decisions/delegationLifecycle';

export function afterDelegationOutcomeDecision(state: OrchestratorStateType) {
  const decisionMode = decisionModeFromRunNextDelegation(state.runNextDelegation);
  if (decisionMode === 'capability') return 'capability';
  if (decisionMode === 'general') return 'general';
  if (state.runPendingFinalReply === 'answer') return 'answer';
  if (state.runPendingFinalReply === 'inline') return 'finalizeRun';
  // A verdict-only task_done clears the active task. Only an existing plan draft
  // keeps the follow-up planning lane open; without one, answer and end.
  if (!state.taskActiveDelegation && !state.runPendingTask && !state.runNextDelegation) {
    return state.runTaskPlanDraft && state.runTaskPlanDraft.length > 0
      ? 'taskDecision'
      : 'answer';
  }
  return 'end';
}
