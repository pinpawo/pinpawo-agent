import type { OrchestratorStateType } from '../../state';

export function afterTaskDecision(state: OrchestratorStateType) {
  if (state.runPendingTask) return 'capabilitySearch';
  if (state.runPendingFinalReply === 'answer') return 'answer';
  if (state.runPendingFinalReply === 'inline') return 'finalizeRun';
  return 'end';
}
