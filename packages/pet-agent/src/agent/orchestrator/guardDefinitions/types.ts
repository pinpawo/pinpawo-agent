import {
  GuardRegistry,
  type Guard,
} from '../../../guards';
import type { OrchestratorStatePatch } from '../controlPrimitives';
import type { OrchestratorStateType } from '../state';

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

export function statePatch(patch: OrchestratorStatePatch): OrchestratorGuardEffect {
  return { type: 'state_patch', patch };
}

export function applyOrchestratorGuardEffect(effect: OrchestratorGuardEffect): OrchestratorStatePatch {
  return effect.patch;
}
