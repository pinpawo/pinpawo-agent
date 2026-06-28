import {
  GuardRegistry,
  type Guard,
} from '../../../guards';
import type { OrchestratorStatePatch } from '../controlPrimitives';
import type { OrchestratorStateType } from '../state';

export const ORCHESTRATOR_GUARD_POSITION = {
  CONTEXT_COMPACTION: 'orchestrator.context_compaction',
  USER_INTENT_DECISION: 'orchestrator.user_intent_decision',
  DELEGATION_OUTCOME_DECISION: 'orchestrator.delegation_outcome_decision',
  DELEGATION_OUTCOME_ITERATION: 'orchestrator.delegation_outcome_iteration',
} as const;

export type OrchestratorGuardPosition =
  typeof ORCHESTRATOR_GUARD_POSITION[keyof typeof ORCHESTRATOR_GUARD_POSITION];

export const ORCHESTRATOR_GUARD_NAME = {
  CONTEXT_COMPACTION_WATERMARK: 'context_compaction_watermark',
  USER_INTENT_DECISION: 'user_intent_decision',
  DELEGATION_OUTCOME_DECISION: 'delegation_outcome_decision',
  RUN_ITERATION_LIMIT: 'run_iteration_limit',
} as const;

export type OrchestratorGuardName =
  typeof ORCHESTRATOR_GUARD_NAME[keyof typeof ORCHESTRATOR_GUARD_NAME];

export type OrchestratorContextCompactionGuardConfig = {
  contextWindowTokens?: number;
  keepMessages?: number;
  triggerRatio?: number;
  triggerTokens?: number;
};

export type OrchestratorGuardConfig = {
  contextCompaction?: OrchestratorContextCompactionGuardConfig;
  runIterationLimit: number;
};

export type OrchestratorGuardEffect =
  | {
      type: 'request_context_compaction';
      mainMessageCount: number;
      keepMessages: number;
      latestInputTokens: number;
      triggerTokens: number;
    }
  | {
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

export function statePatch(patch: OrchestratorStatePatch): OrchestratorGuardEffect {
  return { type: 'state_patch', patch };
}

export function requestContextCompaction(params: {
  mainMessageCount: number;
  keepMessages: number;
  latestInputTokens: number;
  triggerTokens: number;
}): OrchestratorGuardEffect {
  return {
    type: 'request_context_compaction',
    mainMessageCount: params.mainMessageCount,
    keepMessages: params.keepMessages,
    latestInputTokens: params.latestInputTokens,
    triggerTokens: params.triggerTokens,
  };
}

export function applyOrchestratorGuardEffect(effect: OrchestratorGuardEffect | null): OrchestratorStatePatch {
  if (effect === null) {
    return {};
  }
  if (effect.type === 'state_patch') {
    return effect.patch;
  }
  throw new Error(`Orchestrator guard effect is not a state patch: ${effect.type}`);
}
