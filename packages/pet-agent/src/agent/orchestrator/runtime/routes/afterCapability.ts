import type { OrchestratorStateType } from '../../state';

/**
 * A review interruption ends the root run at the capability checkpoint. The
 * active delegation remains pending and is only re-entered by an explicit
 * resume_active transition on a later request.
 */
export function afterCapability(state: OrchestratorStateType) {
  return state.taskActiveDelegation?.status === 'pending'
    ? 'end'
    : 'delegationOutcomeIterationGuard';
}
