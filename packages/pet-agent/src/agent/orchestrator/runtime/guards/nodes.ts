import type { RunnableConfig } from '@langchain/core/runnables';
import {
  ORCHESTRATOR_GUARD_NAME,
  ORCHESTRATOR_GUARD_POSITION,
} from '../../guardDefinitions';
import type { OrchestratorStateType } from '../../state';
import type { OrchestratorGuardRunner } from './runner';

export function createDelegationOutcomeDecisionGuardNode(
  runOrchestratorGuard: OrchestratorGuardRunner,
) {
  return async function delegationOutcomeDecisionGuardNode(
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) {
    return runOrchestratorGuard(
      ORCHESTRATOR_GUARD_NAME.DELEGATION_OUTCOME_DECISION,
      ORCHESTRATOR_GUARD_POSITION.DELEGATION_OUTCOME_DECISION,
      state,
      runnableConfig,
    );
  };
}

export function createDelegationOutcomeIterationGuardNode(
  runOrchestratorGuard: OrchestratorGuardRunner,
) {
  return async function delegationOutcomeIterationGuardNode(
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) {
    return runOrchestratorGuard(
      ORCHESTRATOR_GUARD_NAME.RUN_ITERATION_LIMIT,
      ORCHESTRATOR_GUARD_POSITION.DELEGATION_OUTCOME_ITERATION,
      state,
      runnableConfig,
    );
  };
}
