import type { RunnableConfig } from '@langchain/core/runnables';
import { evaluateGuard } from '../../../../guards';
import {
  ORCHESTRATOR_GUARD_POSITION,
  runIterationLimitGuard,
} from '../../guardDefinitions';
import type { OrchestratorStateType } from '../../state';
import { getInvokeOptions } from '../config';
import { guardDecisionEmitter } from '../guards/decisionEvents';

export function createAfterDelegationOutcomeIterationGuard(params: {
  orchestratorMaxIterations: number;
}) {
  return function afterDelegationOutcomeIterationGuard(
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) {
    const invokeOptions = getInvokeOptions(runnableConfig);
    const runIterationLimit = invokeOptions.maxRunIterations ?? params.orchestratorMaxIterations;
    const outcome = evaluateGuard(runIterationLimitGuard, {
      state,
      config: { runIterationLimit },
      position: ORCHESTRATOR_GUARD_POSITION.DELEGATION_OUTCOME_ITERATION,
    }, {
      emit: guardDecisionEmitter(runnableConfig),
      runId: state.runId,
      iteration: state.runIterationCount,
    });
    return outcome.kind === 'stop' ? 'answer' : 'delegationOutcomeDecision';
  };
}
