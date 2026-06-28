import { GuardRegistry } from '../../../guards';
import { createContextCompactionWatermarkGuard } from './contextCompactionWatermarkGuard';
import { createDelegationOutcomeDecisionGuard } from './delegationOutcomeDecisionGuard';
import { createRunIterationLimitGuard } from './runIterationLimitGuard';
import type { OrchestratorStateType } from '../state';
import {
  type OrchestratorGuardConfig,
  type OrchestratorGuardEffect,
  type OrchestratorGuardPosition,
  type OrchestratorGuardRegistry,
} from './types';
import { createUserIntentDecisionGuard } from './userIntentDecisionGuard';

export {
  applyOrchestratorGuardEffect,
  ORCHESTRATOR_GUARD_NAME,
  ORCHESTRATOR_GUARD_POSITION,
  type OrchestratorGuard,
  type OrchestratorGuardConfig,
  type OrchestratorGuardEffect,
  type OrchestratorGuardName,
  type OrchestratorGuardPosition,
  type OrchestratorGuardRegistry,
} from './types';
export { createContextCompactionWatermarkGuard } from './contextCompactionWatermarkGuard';
export { createDelegationOutcomeDecisionGuard } from './delegationOutcomeDecisionGuard';
export { createRunIterationLimitGuard } from './runIterationLimitGuard';
export { createUserIntentDecisionGuard } from './userIntentDecisionGuard';

export function createOrchestratorGuardRegistry(): OrchestratorGuardRegistry {
  const registry = new GuardRegistry<
    OrchestratorStateType,
    OrchestratorGuardConfig,
    OrchestratorGuardPosition,
    OrchestratorGuardEffect
  >();
  registry.register(createContextCompactionWatermarkGuard());
  registry.register(createUserIntentDecisionGuard());
  registry.register(createDelegationOutcomeDecisionGuard());
  registry.register(createRunIterationLimitGuard());
  return registry;
}
