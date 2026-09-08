import type { RunnableConfig } from '@langchain/core/runnables';
import { evaluateGuard } from '../../../../guards';
import {
  ORCHESTRATOR_GUARD_POSITION,
  runIterationLimitGuard,
} from '../../guardDefinitions';
import type { OrchestratorStateType } from '../../state';
import { ORCHESTRATOR_MAX_ITERATIONS } from '../constants';
import { guardDecisionEmitter } from '../guards/decisionEvents';

export function createAfterSupervisorBoundaryIterationGuard() {
  return function afterSupervisorBoundaryIterationGuard(
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) {
    const outcome = evaluateGuard(runIterationLimitGuard, {
      state,
      config: { runIterationLimit: ORCHESTRATOR_MAX_ITERATIONS },
      position: ORCHESTRATOR_GUARD_POSITION.SUPERVISOR_BOUNDARY_ITERATION,
    }, {
      emit: guardDecisionEmitter(runnableConfig),
      runId: state.runId,
      iteration: state.runIterationCount,
    });
    return outcome.kind === 'stop' ? 'answer' : 'runSupervisor';
  };
}
