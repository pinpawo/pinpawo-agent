import { AIMessage } from '@langchain/core/messages';
import {
  defineGuard,
  guardBlock,
  guardPass,
} from '../../../guards';
import type { TaskActiveDelegation } from '../types';
import {
  ORCHESTRATOR_GUARD_NAME,
  ORCHESTRATOR_GUARD_POSITION,
  statePatch,
  type OrchestratorGuard,
} from './types';

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

export function createRunIterationLimitGuard(): OrchestratorGuard {
  return defineGuard({
    name: ORCHESTRATOR_GUARD_NAME.RUN_ITERATION_LIMIT,
    positions: [ORCHESTRATOR_GUARD_POSITION.DELEGATION_OUTCOME_ITERATION],
    rule: {
      check: ({ config, state }) => {
        const activeDelegation = state.taskActiveDelegation;
        if (!activeDelegation) {
          return guardPass();
        }
        return state.runIterationCount >= config.runIterationLimit
          ? guardBlock('run_iteration_limit_reached')
          : guardPass();
      },
    },
    handler: {
      handle: ({ config, result, state }) => {
        if (result.status === 'pass') {
          return statePatch({ runPendingFinalReply: null });
        }
        const activeDelegation = state.taskActiveDelegation;
        if (!activeDelegation) {
          return statePatch({ runPendingFinalReply: null });
        }
        return statePatch({
          messages: [
            new AIMessage(buildRunIterationLimitMessage(
              activeDelegation,
              config.runIterationLimit,
              state.runIterationCount,
            )),
          ],
          runPendingDelegation: null,
          runPendingFinalReply: 'inline',
          taskActiveDelegation: activeDelegation,
          runIterationCount: 0,
        });
      },
    },
  });
}
