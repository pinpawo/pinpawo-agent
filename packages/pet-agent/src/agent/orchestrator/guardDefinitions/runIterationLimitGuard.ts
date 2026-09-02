import {
  defineGuard,
  guardProceed,
  guardStop,
} from '../../../guards';
import type { OrchestratorStateType } from '../state';
import {
  ORCHESTRATOR_GUARD_NAME,
  ORCHESTRATOR_GUARD_POSITION,
  type OrchestratorGuardPosition,
  type RunIterationLimitGuardConfig,
} from './types';

export const RUN_ITERATION_LIMIT_REACHED = 'run_iteration_limit_reached';

export type RunIterationLimitGuardState =
  Pick<OrchestratorStateType, 'taskActiveDelegation' | 'runIterationCount'>;

export const runIterationLimitGuard = defineGuard<
  RunIterationLimitGuardState,
  RunIterationLimitGuardConfig,
  OrchestratorGuardPosition
>({
  name: ORCHESTRATOR_GUARD_NAME.RUN_ITERATION_LIMIT,
  positions: [ORCHESTRATOR_GUARD_POSITION.SUPERVISOR_BOUNDARY_ITERATION],
  check: ({ config, state }) => {
    if (!state.taskActiveDelegation) {
      return guardProceed();
    }
    return state.runIterationCount >= config.runIterationLimit
      ? guardStop(RUN_ITERATION_LIMIT_REACHED, {
        runIterationCount: state.runIterationCount,
        runIterationLimit: config.runIterationLimit,
      })
      : guardProceed();
  },
});
