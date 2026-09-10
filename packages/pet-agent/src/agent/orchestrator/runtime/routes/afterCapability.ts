import type { OrchestratorStateType } from '../../state';

export function afterCapability(state: OrchestratorStateType) {
  return state.taskPauseInterrupt ? 'pauseGate' : 'supervisorBoundaryIterationGuard';
}
