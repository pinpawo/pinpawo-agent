import { GuardRegistry } from '../../../guards';
import { createContextCompactionWatermarkGuard } from './contextCompactionWatermarkGuard';
import { createDelegationOutcomeDecisionGuard } from './delegationOutcomeDecisionGuard';
import { createForcedCapabilitySeedGuard } from './forcedCapabilitySeedGuard';
import { createRunIterationLimitGuard } from './runIterationLimitGuard';
import { createRunStateResetGuard } from './runStateResetGuard';
import type { OrchestratorStateType } from '../state';
import {
  type OrchestratorGuardConfig,
  type OrchestratorGuardPosition,
  type OrchestratorGuardRegistry,
  type OrchestratorGuardUpdate,
} from './types';

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
} from './contextCompactionWatermarkGuard';
export { createDelegationOutcomeDecisionGuard } from './delegationOutcomeDecisionGuard';
export { createForcedCapabilitySeedGuard } from './forcedCapabilitySeedGuard';
export { createRunIterationLimitGuard } from './runIterationLimitGuard';
export { createRunStateResetGuard } from './runStateResetGuard';

export function createOrchestratorGuardRegistry(): OrchestratorGuardRegistry {
  const registry = new GuardRegistry<
    OrchestratorStateType,
    OrchestratorGuardConfig,
    OrchestratorGuardPosition,
    OrchestratorGuardUpdate
  >();
  registry.register(createContextCompactionWatermarkGuard());
  registry.register(createRunStateResetGuard());
  registry.register(createForcedCapabilitySeedGuard());
  registry.register(createDelegationOutcomeDecisionGuard());
  registry.register(createRunIterationLimitGuard());
  return registry;
}
