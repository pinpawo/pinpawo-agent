import { AIMessage } from '@langchain/core/messages';
import {
  defineGuard,
  guardBlock,
  guardPass,
  GuardRegistry,
  type Guard,
} from '../../guards';
import type { OrchestratorStatePatch } from './controlPrimitives';
import { readLatestAnnounceCompletionReason } from './messageLanes';
import type { OrchestratorStateType } from './state';
import type { TaskActiveDelegation } from './types';

export const ORCHESTRATOR_GUARD_POSITION = {
  USER_INTENT_DECISION: 'orchestrator.user_intent_decision',
  DELEGATION_OUTCOME_DECISION: 'orchestrator.delegation_outcome_decision',
  DELEGATION_OUTCOME_ITERATION: 'orchestrator.delegation_outcome_iteration',
} as const;

export type OrchestratorGuardPosition =
  typeof ORCHESTRATOR_GUARD_POSITION[keyof typeof ORCHESTRATOR_GUARD_POSITION];

export const ORCHESTRATOR_GUARD_NAME = {
  USER_INTENT_DECISION: 'user_intent_decision',
  DELEGATION_OUTCOME_DECISION: 'delegation_outcome_decision',
  RUN_ITERATION_LIMIT: 'run_iteration_limit',
} as const;

export type OrchestratorGuardName =
  typeof ORCHESTRATOR_GUARD_NAME[keyof typeof ORCHESTRATOR_GUARD_NAME];

export type OrchestratorGuardConfig = {
  runIterationLimit: number;
};

export type OrchestratorGuardEffect = {
  type: 'state_patch';
  patch: OrchestratorStatePatch;
};

export type OrchestratorGuard = Guard<
  OrchestratorStateType,
  OrchestratorGuardConfig,
  OrchestratorGuardPosition,
  OrchestratorGuardEffect
>;

export type OrchestratorGuardRegistry = GuardRegistry<
  OrchestratorStateType,
  OrchestratorGuardConfig,
  OrchestratorGuardPosition,
  OrchestratorGuardEffect
>;

function statePatch(patch: OrchestratorStatePatch): OrchestratorGuardEffect {
  return { type: 'state_patch', patch };
}

export function applyOrchestratorGuardEffect(effect: OrchestratorGuardEffect): OrchestratorStatePatch {
  return effect.patch;
}

function readActiveDelegation(state: OrchestratorStateType): TaskActiveDelegation | null {
  return state.taskActiveDelegation;
}

function buildRunIterationLimitMessage(
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

export function createUserIntentDecisionGuard(): OrchestratorGuard {
  return defineGuard({
    name: ORCHESTRATOR_GUARD_NAME.USER_INTENT_DECISION,
    positions: [ORCHESTRATOR_GUARD_POSITION.USER_INTENT_DECISION],
    rule: {
      check: () => guardPass(),
    },
    handler: {
      handle: () => statePatch({ canHandoffActiveDelegation: true }),
    },
  });
}

export function createDelegationOutcomeDecisionGuard(): OrchestratorGuard {
  return defineGuard({
    name: ORCHESTRATOR_GUARD_NAME.DELEGATION_OUTCOME_DECISION,
    positions: [ORCHESTRATOR_GUARD_POSITION.DELEGATION_OUTCOME_DECISION],
    rule: {
      check: ({ state }) => {
        const activeDelegation = readActiveDelegation(state);
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

export function createRunIterationLimitGuard(): OrchestratorGuard {
  return defineGuard({
    name: ORCHESTRATOR_GUARD_NAME.RUN_ITERATION_LIMIT,
    positions: [ORCHESTRATOR_GUARD_POSITION.DELEGATION_OUTCOME_ITERATION],
    rule: {
      check: ({ config, state }) => {
        const activeDelegation = readActiveDelegation(state);
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
        const activeDelegation = readActiveDelegation(state);
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

export function createOrchestratorGuardRegistry(): OrchestratorGuardRegistry {
  const registry = new GuardRegistry<
    OrchestratorStateType,
    OrchestratorGuardConfig,
    OrchestratorGuardPosition,
    OrchestratorGuardEffect
  >();
  registry.register(createUserIntentDecisionGuard());
  registry.register(createDelegationOutcomeDecisionGuard());
  registry.register(createRunIterationLimitGuard());
  return registry;
}
