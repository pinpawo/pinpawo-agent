import type { RunnableConfig } from '@langchain/core/runnables';
import { Command } from '@langchain/langgraph';
import { evaluateGuard } from '../../../../guards';
import {
  ORCHESTRATOR_GUARD_POSITION,
  runIterationLimitGuard,
} from '../../guardDefinitions';
import type { OrchestratorStateType } from '../../state';
import { getInvokeOptions } from '../config';
import { guardDecisionEmitter } from '../guards/decisionEvents';

export function createPlannerBoundaryIterationGuardNode(params: {
  orchestratorMaxIterations: number;
}) {
  return function plannerBoundaryIterationGuardNode(
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) {
    const invokeOptions = getInvokeOptions(runnableConfig);
    const runIterationLimit = invokeOptions.maxRunIterations
      ?? params.orchestratorMaxIterations;
    const outcome = evaluateGuard(runIterationLimitGuard, {
      state,
      config: { runIterationLimit },
      position: ORCHESTRATOR_GUARD_POSITION.PLANNER_BOUNDARY_ITERATION,
    }, {
      emit: guardDecisionEmitter(runnableConfig),
      runId: state.runId,
      iteration: state.runIterationCount,
    });
    if (outcome.kind === 'stop') {
      return new Command({
        update: {
          runTerminalOutcome: { kind: 'iteration_limit' as const },
        },
        goto: 'finalizeRun',
      });
    }
    return new Command({ goto: 'capabilityPlanner' });
  };
}
