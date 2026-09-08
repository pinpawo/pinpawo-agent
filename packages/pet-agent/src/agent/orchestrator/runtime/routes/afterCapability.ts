import type { OrchestratorStateType } from '../../state';

/**
 * A task pause suspends the root at pauseGate after the capability checkpoint.
 * Its pending delegation resumes through the interrupt or a legacy
 * resume_active turn; a delivered result goes to Supervisor Boundary.
 */
export function afterCapability(state: OrchestratorStateType) {
  return state.taskActiveDelegation?.status === 'pending'
    ? 'pauseGate'
    : 'supervisorBoundaryIterationGuard';
}
