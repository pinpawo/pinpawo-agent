import {
  defineGuard,
  guardPass,
} from '../../../guards';
import {
  ORCHESTRATOR_GUARD_NAME,
  ORCHESTRATOR_GUARD_POSITION,
  statePatch,
  type OrchestratorGuard,
} from './types';

export function createUserIntentDecisionGuard(): OrchestratorGuard {
  return defineGuard({
    name: ORCHESTRATOR_GUARD_NAME.USER_INTENT_DECISION,
    positions: [ORCHESTRATOR_GUARD_POSITION.USER_INTENT_DECISION],
    rule: {
      check: () => guardPass(),
    },
    handler: {
      handle: () => statePatch({ canHandoffActiveDelegation: true }),
    },
  });
}
