import {
  defineGuard,
  guardDerive,
} from '../../../guards';
import { readLatestAnnounceCompletionReason } from '../messageLanes';
import type { OrchestratorStateType } from '../state';
import {
  ORCHESTRATOR_GUARD_NAME,
  ORCHESTRATOR_GUARD_POSITION,
  type EmptyGuardConfig,
  type OrchestratorGuardPosition,
} from './types';

export const ACTIVE_DELEGATION_LIMIT_REACHED = 'active_delegation_limit_reached';
export const DELEGATION_HANDOFF_ALLOWED = 'delegation_handoff_allowed';

export type DelegationOutcomeDecisionGuardState =
  Pick<OrchestratorStateType, 'taskActiveDelegation' | 'messages'>;

/**
 * Derives whether the active delegation may be handed off. This guard derives
 * on every evaluation — allowing handoff is as much a decision as refusing it.
 */
export const delegationOutcomeDecisionGuard = defineGuard<
  DelegationOutcomeDecisionGuardState,
  EmptyGuardConfig,
  OrchestratorGuardPosition
>({
  name: ORCHESTRATOR_GUARD_NAME.DELEGATION_OUTCOME_DECISION,
  positions: [ORCHESTRATOR_GUARD_POSITION.DELEGATION_OUTCOME_DECISION],
  check: ({ state }) => {
    const activeDelegation = state.taskActiveDelegation;
    if (!activeDelegation) {
      return guardDerive(DELEGATION_HANDOFF_ALLOWED, {
        canHandoffActiveDelegation: true,
        completionReason: null,
      });
    }
    const completionReason = readLatestAnnounceCompletionReason(state.messages, {
      runId: activeDelegation.transcriptRunId,
      delegationId: activeDelegation.id,
    });
    return completionReason === 'limit_reached'
      ? guardDerive(ACTIVE_DELEGATION_LIMIT_REACHED, {
        canHandoffActiveDelegation: false,
        completionReason,
      })
      : guardDerive(DELEGATION_HANDOFF_ALLOWED, {
        canHandoffActiveDelegation: true,
        completionReason,
      });
  },
});
