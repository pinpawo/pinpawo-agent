import type { AgentCapability } from '../../../types/capability';
import type { OrchestratorStatePatch } from '../controlPrimitives';

export const ORCHESTRATOR_GUARD_POSITION = {
  PREPARE: 'orchestrator.prepare',
  CONTEXT_COMPACTION: 'orchestrator.context_compaction',
  CAPABILITY_DISCOVERY: 'orchestrator.capability_discovery',
  DELEGATION_OUTCOME_DECISION: 'orchestrator.delegation_outcome_decision',
  DELEGATION_OUTCOME_ITERATION: 'orchestrator.delegation_outcome_iteration',
} as const;

export type OrchestratorGuardPosition =
  typeof ORCHESTRATOR_GUARD_POSITION[keyof typeof ORCHESTRATOR_GUARD_POSITION];

export const ORCHESTRATOR_GUARD_NAME = {
  RUN_STATE_RESET: 'run_state_reset',
  CONTEXT_COMPACTION_WATERMARK: 'context_compaction_watermark',
  FORCED_CAPABILITY_SEED: 'forced_capability_seed',
  DELEGATION_OUTCOME_DECISION: 'delegation_outcome_decision',
  RUN_ITERATION_LIMIT: 'run_iteration_limit',
} as const;

export type OrchestratorGuardName =
  typeof ORCHESTRATOR_GUARD_NAME[keyof typeof ORCHESTRATOR_GUARD_NAME];

// Per-guard configs: each guard declares the minimal config it reads; the
// position assembles it from OrchestratorConfig / invoke options.

export type EmptyGuardConfig = Record<string, never>;

export type ContextCompactionWatermarkGuardConfig = {
  contextWindowTokens?: number;
  keepMessages?: number;
};

export type ForcedCapabilitySeedGuardConfig = {
  forcedCapabilityNames?: string[];
  capabilities?: AgentCapability[];
};

export type RunIterationLimitGuardConfig = {
  runIterationLimit: number;
};

export function statePatch(patch: OrchestratorStatePatch): OrchestratorStatePatch {
  return patch;
}
