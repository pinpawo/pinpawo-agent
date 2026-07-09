import type { OrchestratorStateType } from '../../state';

export function afterTaskDecision(state: OrchestratorStateType) {
  return state.runPendingTask ? 'capabilitySearch' : 'answer';
}
