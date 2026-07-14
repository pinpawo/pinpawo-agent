export const SUBAGENT_GUARD_POSITION = {
  BEFORE_MODEL_ITERATION: 'subagent.before_model_iteration',
} as const;

export type SubagentGuardPosition =
  typeof SUBAGENT_GUARD_POSITION[keyof typeof SUBAGENT_GUARD_POSITION];

export const SUBAGENT_GUARD_NAME = {
  ITERATION_LIMIT: 'subagent_iteration_limit',
} as const;

export type SubagentGuardName =
  typeof SUBAGENT_GUARD_NAME[keyof typeof SUBAGENT_GUARD_NAME];

export type SubagentIterationLimitGuardState = {
  iterationCount: number;
  maxIterations: number;
};

export type EmptyGuardConfig = Record<string, never>;
