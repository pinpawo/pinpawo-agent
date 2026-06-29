import {
  defineGuard,
  guardBlock,
  guardPass,
} from '../../../guards';
import { buildRunStateReset } from '../state';
import {
  ORCHESTRATOR_GUARD_NAME,
  ORCHESTRATOR_GUARD_POSITION,
  statePatch,
  type OrchestratorGuard,
} from './types';

export function createRunStateResetGuard(): OrchestratorGuard {
  return defineGuard({
    name: ORCHESTRATOR_GUARD_NAME.RUN_STATE_RESET,
    positions: [ORCHESTRATOR_GUARD_POSITION.PREPARE],
    rule: {
      check: ({ state }) => state.runId
        ? guardPass()
        : guardBlock('run_state_reset_required'),
    },
    handler: {
      handle: ({ result }) => result.status === 'block'
        ? statePatch(buildRunStateReset())
        : null,
    },
  });
}
