import type { BaseMessage } from '@langchain/core/messages';
import type { SubagentContextManagement } from '../../types/subagent';

export const SUBAGENT_GUARD_POSITION = {
  BEFORE_MODEL_CONTEXT_MANAGEMENT: 'subagent.before_model_context_management',
  BEFORE_MODEL_ITERATION: 'subagent.before_model_iteration',
} as const;

export type SubagentGuardPosition =
  typeof SUBAGENT_GUARD_POSITION[keyof typeof SUBAGENT_GUARD_POSITION];

export const SUBAGENT_GUARD_NAME = {
  CONTEXT_MAINTENANCE: 'context_maintenance',
  ITERATION_LIMIT: 'subagent_iteration_limit',
} as const;

export type SubagentGuardName =
  typeof SUBAGENT_GUARD_NAME[keyof typeof SUBAGENT_GUARD_NAME];

// Guard rules declare the minimal input they read; middleware hooks pass their
// hook-local values directly instead of snapshotting a synthetic full state.

export type ContextMaintenanceGuardState = {
  messages: BaseMessage[];
  contextManagement?: SubagentContextManagement;
};

export type ContextMaintenanceGuardConfig = {
  contextWindowTokens?: number;
};

export type SubagentIterationLimitGuardState = {
  iterationCount: number;
  maxIterations: number;
};

export type EmptyGuardConfig = Record<string, never>;
