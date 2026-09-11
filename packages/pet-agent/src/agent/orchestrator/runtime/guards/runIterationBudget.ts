import type { RunnableConfig } from '@langchain/core/runnables';
import { evaluateGuard } from '../../../../guards';
import { ORCHESTRATOR_GUARD_POSITION, runIterationLimitGuard } from '../../guardDefinitions';
import type { OrchestratorStateType } from '../../state';
import { ORCHESTRATOR_MAX_ITERATIONS } from '../constants';
import { guardDecisionEmitter } from './decisionEvents';

/** All Supervisor entries, including native pause resumes, share this budget. */
export function runIterationBudgetReached(state: OrchestratorStateType, config?: RunnableConfig): boolean {
  const outcome = evaluateGuard(runIterationLimitGuard, {
    state,
    config: { runIterationLimit: ORCHESTRATOR_MAX_ITERATIONS },
    position: ORCHESTRATOR_GUARD_POSITION.SUPERVISOR_BOUNDARY_ITERATION,
  }, {
    emit: guardDecisionEmitter(config), runId: state.runId, iteration: state.runIterationCount,
  });
  return outcome.kind === 'stop';
}
