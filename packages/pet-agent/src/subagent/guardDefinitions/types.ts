import {
  GuardRegistry,
  type Guard,
} from '../../guards';
import type { SubagentInputState } from '../../types/subagent';

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

export type SubagentState = Omit<SubagentInputState, 'maxIterations'> & {
  iterationCount: number;
  maxIterations: number;
};

export type SubagentGuardConfig = {
  contextWindowTokens?: number;
};

export type SubagentGuardUpdate = Partial<Pick<SubagentState, 'messages'>>;

export type SubagentGuard = Guard<
  SubagentState,
  SubagentGuardConfig,
  SubagentGuardPosition,
  SubagentGuardUpdate
>;

export type SubagentGuardRegistry = GuardRegistry<
  SubagentState,
  SubagentGuardConfig,
  SubagentGuardPosition,
  SubagentGuardUpdate
>;
