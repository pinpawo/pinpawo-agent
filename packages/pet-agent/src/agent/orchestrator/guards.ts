import { AIMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { OrchestratorStateType } from './state';
import type { OrchestratorInvokeOptions, TaskActiveDelegation } from './types';
import { readLatestAnnounceCompletionReason } from './messageLanes';
import type { OrchestratorGuard } from './controlPrimitives';

/**
 * Orchestrator Guards — the deterministic, no-LLM pass/block checks of the
 * control graph, extracted out of createAgentRuntime as concrete
 * `OrchestratorGuard` implementations (P5 / #281).
 *
 * `getInvokeOptions` is injected rather than imported: it is invoke-config
 * parsing used broadly across the runtime, so it stays defined there and is
 * passed in here to keep this module dependency-light and cycle-free.
 */

/** Latest in-progress/completed delegation, used as a legacy fallback for active state. */
export function readLegacyTaskActiveDelegation(
  state: OrchestratorStateType,
): TaskActiveDelegation | null {
  let delegation = null as OrchestratorStateType['runDelegations'][number] | null;
  for (let index = state.runDelegations.length - 1; index >= 0; index -= 1) {
    const item = state.runDelegations[index];
    if (item.status === 'progress' || item.status === 'completed') {
      delegation = item;
      break;
    }
  }
  if (!delegation) return null;
  return {
    id: delegation.id,
    lane: delegation.lane,
    task: delegation.task,
    contextSummary: null,
    transcriptRunId: state.runId,
    status: 'awaiting_decision',
    resultPreview: delegation.resultPreview,
  };
}

export function buildRunIterationLimitMessage(
  delegation: TaskActiveDelegation,
  limit: number,
  count: number,
): string {
  return [
    `主流程循环已达到上限：${count}/${limit}。`,
    `当前仍保留委派任务“${delegation.task}”（${delegation.lane}）。`,
    '该轮委派记录为待续跑状态，可继续提交下一轮任务让我接着推进。',
  ].join('\n');
}

export type OrchestratorGuardDeps = {
  getInvokeOptions: (runnableConfig?: RunnableConfig) => OrchestratorInvokeOptions;
};

export type OrchestratorGuards = {
  userIntentDecisionGuard: OrchestratorGuard;
  delegationOutcomeDecisionGuard: OrchestratorGuard;
  runIterationLimitGuard: OrchestratorGuard;
};

export function createOrchestratorGuards(deps: OrchestratorGuardDeps): OrchestratorGuards {
  const { getInvokeOptions } = deps;

  const userIntentDecisionGuard: OrchestratorGuard = () => {
    return { canHandoffActiveDelegation: true };
  };

  const delegationOutcomeDecisionGuard: OrchestratorGuard = (state) => {
    const activeDelegation = state.taskActiveDelegation ?? readLegacyTaskActiveDelegation(state);
    if (!activeDelegation) {
      return { canHandoffActiveDelegation: true };
    }
    const activeDelegationCompletionReason = readLatestAnnounceCompletionReason(state.messages, {
      runId: activeDelegation.transcriptRunId,
      delegationId: activeDelegation.id,
    });
    return {
      canHandoffActiveDelegation: activeDelegationCompletionReason !== 'limit_reached',
    };
  };

  const runIterationLimitGuard: OrchestratorGuard = (state, ctx) => {
    const { maxRunIterations } = getInvokeOptions(ctx.runnableConfig);
    const activeDelegation = state.taskActiveDelegation ?? readLegacyTaskActiveDelegation(state);
    if (!activeDelegation) {
      return { runPendingFinalReply: null };
    }
    const maxRunIterationLimit = maxRunIterations ?? ctx.orchestratorMaxIterations;
    if (state.runIterationCount < maxRunIterationLimit) {
      return { runPendingFinalReply: null };
    }
    return {
      messages: [
        new AIMessage(buildRunIterationLimitMessage(
          activeDelegation,
          maxRunIterationLimit,
          state.runIterationCount,
        )),
      ],
      runPendingDelegation: null,
      runPendingFinalReply: 'inline',
      taskActiveDelegation: activeDelegation,
      runIterationCount: 0,
    };
  };

  return { userIntentDecisionGuard, delegationOutcomeDecisionGuard, runIterationLimitGuard };
}
