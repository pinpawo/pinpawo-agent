import {
  defineGuard,
  guardDerive,
  guardProceed,
} from '../../../guards';
import type { OrchestratorStateType } from '../state';
import {
  ORCHESTRATOR_GUARD_NAME,
  ORCHESTRATOR_GUARD_POSITION,
  type EmptyGuardConfig,
  type OrchestratorGuardPosition,
} from './types';

export const RUN_STATE_RESET_REQUIRED = 'run_state_reset_required';

export type RunStateResetGuardState = Pick<OrchestratorStateType, 'runId'>;

export const runStateResetGuard = defineGuard<
  RunStateResetGuardState,
  EmptyGuardConfig,
  OrchestratorGuardPosition
>({
  name: ORCHESTRATOR_GUARD_NAME.RUN_STATE_RESET,
  positions: [ORCHESTRATOR_GUARD_POSITION.PREPARE],
  check: ({ state }) => state.runId
    ? guardProceed()
    : guardDerive(RUN_STATE_RESET_REQUIRED),
});
