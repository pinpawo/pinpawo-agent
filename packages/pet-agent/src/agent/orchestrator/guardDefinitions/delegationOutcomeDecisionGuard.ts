import {
  defineGuard,
  guardBlock,
  guardPass,
} from '../../../guards';
import { readLatestAnnounceCompletionReason } from '../messageLanes';
import {
  ORCHESTRATOR_GUARD_NAME,
  ORCHESTRATOR_GUARD_POSITION,
  statePatch,
  type OrchestratorGuard,
} from './types';

export function createDelegationOutcomeDecisionGuard(): OrchestratorGuard {
  return defineGuard({
    name: ORCHESTRATOR_GUARD_NAME.DELEGATION_OUTCOME_DECISION,
    positions: [ORCHESTRATOR_GUARD_POSITION.DELEGATION_OUTCOME_DECISION],
    rule: {
      check: ({ state }) => {
        const activeDelegation = state.taskActiveDelegation;
        if (!activeDelegation) {
          return guardPass();
        }
        const completionReason = readLatestAnnounceCompletionReason(state.messages, {
          runId: activeDelegation.transcriptRunId,
          delegationId: activeDelegation.id,
        });
        return completionReason === 'limit_reached'
          ? guardBlock('active_delegation_limit_reached')
          : guardPass();
      },
    },
    handler: {
      handle: ({ result }) => statePatch({
        canHandoffActiveDelegation: result.status !== 'block',
      }),
    },
  });
}
