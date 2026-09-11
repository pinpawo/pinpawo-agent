export const ORCHESTRATOR_GUARD_POSITION = {
  CONTEXT_COMPACTION: 'orchestrator.context_compaction',
  SUPERVISOR_BOUNDARY_ITERATION: 'orchestrator.supervisor_boundary_iteration',
} as const;

export type OrchestratorGuardPosition =
  typeof ORCHESTRATOR_GUARD_POSITION[keyof typeof ORCHESTRATOR_GUARD_POSITION];

export const ORCHESTRATOR_GUARD_NAME = {
  CONTEXT_COMPACTION_WATERMARK: 'context_compaction_watermark',
  RUN_ITERATION_LIMIT: 'run_iteration_limit',
} as const;

export type OrchestratorGuardName =
  typeof ORCHESTRATOR_GUARD_NAME[keyof typeof ORCHESTRATOR_GUARD_NAME];

// Per-guard configs: each guard declares the minimal config it reads; the
// position assembles it from OrchestratorConfig / invoke options.

export type ContextCompactionWatermarkGuardConfig = {
  contextWindowTokens?: number;
  generationReserveTokens?: number;
  /** Recent suffix retained after compaction; this is not a trigger threshold. */
  keepMessages?: number;
};

export type RunIterationLimitGuardConfig = {
  runIterationLimit: number;
};
