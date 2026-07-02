import {
  defineGuard,
  guardProceed,
  guardStop,
} from '../../guards';
import {
  SUBAGENT_GUARD_NAME,
  SUBAGENT_GUARD_POSITION,
  type EmptyGuardConfig,
  type SubagentGuardPosition,
  type SubagentIterationLimitGuardState,
} from './types';

export const SUBAGENT_ITERATION_LIMIT_REACHED = 'subagent_iteration_limit_reached';

export const subagentIterationLimitGuard = defineGuard<
  SubagentIterationLimitGuardState,
  EmptyGuardConfig,
  SubagentGuardPosition
>({
  name: SUBAGENT_GUARD_NAME.ITERATION_LIMIT,
  positions: [SUBAGENT_GUARD_POSITION.BEFORE_MODEL_ITERATION],
  check: ({ state }) => {
    const maxIterations = state.maxIterations;
    if (!maxIterations || !Number.isFinite(maxIterations) || maxIterations <= 0) {
      return guardProceed();
    }
    return state.iterationCount > maxIterations
      ? guardStop(SUBAGENT_ITERATION_LIMIT_REACHED, {
        iterationCount: state.iterationCount,
        maxIterations,
      })
      : guardProceed();
  },
});
