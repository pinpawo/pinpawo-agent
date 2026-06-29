import {
  GuardRegistry,
  type Guard,
} from '../../../guards';
import type { AgentCapability } from '../../../types/capability';
import type { OrchestratorStatePatch } from '../controlPrimitives';
import type { OrchestratorStateType } from '../state';

export const ORCHESTRATOR_GUARD_POSITION = {
  PREPARE: 'orchestrator.prepare',
  CONTEXT_COMPACTION: 'orchestrator.context_compaction',
  CAPABILITY_DISCOVERY: 'orchestrator.capability_discovery',
  USER_INTENT_DECISION: 'orchestrator.user_intent_decision',
  DELEGATION_OUTCOME_DECISION: 'orchestrator.delegation_outcome_decision',
  DELEGATION_OUTCOME_ITERATION: 'orchestrator.delegation_outcome_iteration',
  CAPABILITY_NODE: 'orchestrator.capability_node',
  GENERAL_NODE: 'orchestrator.general_node',
} as const;

export type OrchestratorGuardPosition =
  typeof ORCHESTRATOR_GUARD_POSITION[keyof typeof ORCHESTRATOR_GUARD_POSITION];

export const ORCHESTRATOR_GUARD_NAME = {
  RUN_STATE_RESET: 'run_state_reset',
  CONTEXT_COMPACTION_WATERMARK: 'context_compaction_watermark',
  FORCED_CAPABILITY_SEED: 'forced_capability_seed',
  USER_INTENT_DECISION: 'user_intent_decision',
  DELEGATION_OUTCOME_DECISION: 'delegation_outcome_decision',
  RUN_ITERATION_LIMIT: 'run_iteration_limit',
  CAPABILITY_PENDING_DELEGATION: 'capability_pending_delegation',
  GENERAL_PENDING_DELEGATION: 'general_pending_delegation',
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
  capabilities?: AgentCapability[];
  contextCompaction?: OrchestratorContextCompactionGuardConfig;
  forcedCapabilityNames?: string[];
  runIterationLimit: number;
};

export type OrchestratorGuardUpdate = OrchestratorStatePatch;

export type OrchestratorGuard = Guard<
  OrchestratorStateType,
  OrchestratorGuardConfig,
  OrchestratorGuardPosition,
  OrchestratorGuardUpdate
>;

export type OrchestratorGuardRegistry = GuardRegistry<
  OrchestratorStateType,
  OrchestratorGuardConfig,
  OrchestratorGuardPosition,
  OrchestratorGuardUpdate
>;

export function statePatch(patch: OrchestratorStatePatch): OrchestratorGuardUpdate {
  return patch;
}
