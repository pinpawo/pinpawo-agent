import type { BaseMessage } from '@langchain/core/messages';
import {
  GuardRegistry,
  type Guard,
} from '../../guards';
import type {
  SubagentContextPolicy,
  SubagentToolOperationMetadata,
} from '../../types/subagent';

export const SUBAGENT_GUARD_POSITION = {
  BEFORE_MODEL_CONTEXT_POLICY: 'subagent.before_model_context_policy',
  BEFORE_MODEL_ITERATION: 'subagent.before_model_iteration',
} as const;

export type SubagentGuardPosition =
  typeof SUBAGENT_GUARD_POSITION[keyof typeof SUBAGENT_GUARD_POSITION];

export const SUBAGENT_GUARD_NAME = {
  CONTEXT_REWRITE_WATERMARK: 'context_rewrite_watermark',
  ITERATION_LIMIT: 'subagent_iteration_limit',
} as const;

export type SubagentGuardName =
  typeof SUBAGENT_GUARD_NAME[keyof typeof SUBAGENT_GUARD_NAME];

export type SubagentState = {
  messages: BaseMessage[];
};

export type SubagentGuardConfig = {
  contextPolicy?: SubagentContextPolicy;
  contextWindowTokens?: number;
  iterationCount: number;
  maxIterations?: number;
  operations?: Record<string, SubagentToolOperationMetadata>;
};

export type SubagentGuardEffect =
  | {
      type: 'request_context_rewrite';
      latestInputTokens: number;
      triggerTokens: number;
    }
  | {
      type: 'stop_loop';
      reason: 'limit_reached';
      notice: string;
    };

export type SubagentGuard = Guard<
  SubagentState,
  SubagentGuardConfig,
  SubagentGuardPosition,
  SubagentGuardEffect
>;

export type SubagentGuardRegistry = GuardRegistry<
  SubagentState,
  SubagentGuardConfig,
  SubagentGuardPosition,
  SubagentGuardEffect
>;

export function requestContextRewrite(params: {
  latestInputTokens: number;
  triggerTokens: number;
}): SubagentGuardEffect {
  return {
    type: 'request_context_rewrite',
    latestInputTokens: params.latestInputTokens,
    triggerTokens: params.triggerTokens,
  };
}

export function stopSubagentLoop(notice: string): SubagentGuardEffect {
  return {
    type: 'stop_loop',
    reason: 'limit_reached',
    notice,
  };
}
