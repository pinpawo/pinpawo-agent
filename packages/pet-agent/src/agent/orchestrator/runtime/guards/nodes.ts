import { AIMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { evaluateGuard } from '../../../../guards';
import {
  ACTIVE_DELEGATION_LIMIT_REACHED,
  delegationOutcomeDecisionGuard,
  ORCHESTRATOR_GUARD_POSITION,
  runIterationLimitGuard,
  statePatch,
} from '../../guardDefinitions';
import type { OrchestratorStateType } from '../../state';
import type { TaskActiveDelegation } from '../../types';
import { getInvokeOptions } from '../config';
import { guardDecisionEmitter } from './decisionEvents';

function buildRunIterationLimitMessage(
  delegation: TaskActiveDelegation,
  limit: number,
  count: number,
): string {
  return [
    `主流程循环已达到上限：${count}/${limit}。`,
    `当前仍保留 delegated task“${delegation.task}”（${delegation.lane}）。`,
    '该轮 delegation record 为待续跑状态，可继续提交下一轮任务让我接着推进。',
  ].join('\n');
}

export function createDelegationOutcomeDecisionGuardNode() {
  return async function delegationOutcomeDecisionGuardNode(
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) {
    const outcome = evaluateGuard(delegationOutcomeDecisionGuard, {
      state,
      config: {},
      position: ORCHESTRATOR_GUARD_POSITION.DELEGATION_OUTCOME_DECISION,
    }, { emit: guardDecisionEmitter(runnableConfig), runId: state.runId });
    return statePatch({
      canHandoffActiveDelegation:
        !(outcome.kind === 'derive' && outcome.reason === ACTIVE_DELEGATION_LIMIT_REACHED),
    });
  };
}

export function createDelegationOutcomeIterationGuardNode(params: {
  orchestratorMaxIterations: number;
}) {
  return async function delegationOutcomeIterationGuardNode(
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
    const activeDelegation = state.taskActiveDelegation;
    if (outcome.kind !== 'stop' || !activeDelegation) {
      return statePatch({ runPendingFinalReply: null });
    }
    return statePatch({
      messages: [
        new AIMessage(buildRunIterationLimitMessage(
          activeDelegation,
          runIterationLimit,
          state.runIterationCount,
        )),
      ],
      runPendingDelegation: null,
      runPendingFinalReply: 'inline',
      taskActiveDelegation: activeDelegation,
      runIterationCount: 0,
    });
  };
}
