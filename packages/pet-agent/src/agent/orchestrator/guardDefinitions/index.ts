import { GuardRegistry } from '../../../guards';
import {
  createContextCompactionWatermarkGuard,
  type ContextCompactionWatermarkGuardOptions,
} from './contextCompactionWatermarkGuard';
import { createDelegationOutcomeDecisionGuard } from './delegationOutcomeDecisionGuard';
import { createRunIterationLimitGuard } from './runIterationLimitGuard';
import type { OrchestratorStateType } from '../state';
import {
  type OrchestratorGuardConfig,
  type OrchestratorGuardPosition,
  type OrchestratorGuardRegistry,
  type OrchestratorGuardUpdate,
} from './types';
import { createUserIntentDecisionGuard } from './userIntentDecisionGuard';

export {
  ORCHESTRATOR_GUARD_NAME,
  ORCHESTRATOR_GUARD_POSITION,
  type OrchestratorGuard,
  type OrchestratorGuardConfig,
  type OrchestratorGuardName,
  type OrchestratorGuardPosition,
  type OrchestratorGuardRegistry,
  type OrchestratorGuardUpdate,
} from './types';
export {
  createContextCompactionWatermarkGuard,
  type ContextCompactionWatermarkGuardBlockHandler,
  type ContextCompactionWatermarkGuardBlockInput,
  type ContextCompactionWatermarkGuardOptions,
} from './contextCompactionWatermarkGuard';
export { createDelegationOutcomeDecisionGuard } from './delegationOutcomeDecisionGuard';
export { createRunIterationLimitGuard } from './runIterationLimitGuard';
export { createUserIntentDecisionGuard } from './userIntentDecisionGuard';

export type OrchestratorGuardRegistryOptions = {
  contextCompaction?: ContextCompactionWatermarkGuardOptions;
};

export function createOrchestratorGuardRegistry(
  options: OrchestratorGuardRegistryOptions = {},
): OrchestratorGuardRegistry {
  const registry = new GuardRegistry<
    OrchestratorStateType,
    OrchestratorGuardConfig,
    OrchestratorGuardPosition,
    OrchestratorGuardUpdate
  >();
  if (options.contextCompaction) {
    registry.register(createContextCompactionWatermarkGuard(options.contextCompaction));
  }
  registry.register(createUserIntentDecisionGuard());
  registry.register(createDelegationOutcomeDecisionGuard());
  registry.register(createRunIterationLimitGuard());
  return registry;
}
