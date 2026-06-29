import { GuardRegistry } from '../../../guards';
import { createCapabilityPendingDelegationGuard } from './capabilityPendingDelegationGuard';
import {
  createContextCompactionWatermarkGuard,
  type ContextCompactionWatermarkGuardOptions,
} from './contextCompactionWatermarkGuard';
import { createDelegationOutcomeDecisionGuard } from './delegationOutcomeDecisionGuard';
import { createForcedCapabilitySeedGuard } from './forcedCapabilitySeedGuard';
import { createGeneralPendingDelegationGuard } from './generalPendingDelegationGuard';
import { createRunIterationLimitGuard } from './runIterationLimitGuard';
import { createRunStateResetGuard } from './runStateResetGuard';
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
  createCapabilityPendingDelegationGuard,
  type CapabilityPendingDelegationGuardBlockInput,
  type CapabilityPendingDelegationGuardOptions,
} from './capabilityPendingDelegationGuard';
export {
  createContextCompactionWatermarkGuard,
  type ContextCompactionWatermarkGuardBlockHandler,
  type ContextCompactionWatermarkGuardBlockInput,
  type ContextCompactionWatermarkGuardOptions,
} from './contextCompactionWatermarkGuard';
export { createDelegationOutcomeDecisionGuard } from './delegationOutcomeDecisionGuard';
export { createForcedCapabilitySeedGuard } from './forcedCapabilitySeedGuard';
export {
  createGeneralPendingDelegationGuard,
  type GeneralPendingDelegationGuardBlockInput,
  type GeneralPendingDelegationGuardOptions,
} from './generalPendingDelegationGuard';
export { createRunIterationLimitGuard } from './runIterationLimitGuard';
export { createRunStateResetGuard } from './runStateResetGuard';
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
  registry.register(createRunStateResetGuard());
  registry.register(createForcedCapabilitySeedGuard());
  registry.register(createUserIntentDecisionGuard());
  registry.register(createDelegationOutcomeDecisionGuard());
  registry.register(createRunIterationLimitGuard());
  registry.register(createCapabilityPendingDelegationGuard());
  registry.register(createGeneralPendingDelegationGuard());
  return registry;
}
