import { GuardRegistry } from '../../guards';
import { createContextRewriteWatermarkGuard } from './contextRewriteWatermarkGuard';
import { createSubagentIterationLimitGuard } from './iterationLimitGuard';
import {
  type SubagentGuardConfig,
  type SubagentGuardEffect,
  type SubagentGuardPosition,
  type SubagentGuardRegistry,
  type SubagentState,
} from './types';

export { createContextRewriteWatermarkGuard } from './contextRewriteWatermarkGuard';
export { createSubagentIterationLimitGuard } from './iterationLimitGuard';
export {
  requestContextRewrite,
  stopSubagentLoop,
  SUBAGENT_GUARD_NAME,
  SUBAGENT_GUARD_POSITION,
  type SubagentGuard,
  type SubagentGuardConfig,
  type SubagentGuardEffect,
  type SubagentGuardName,
  type SubagentGuardPosition,
  type SubagentGuardRegistry,
  type SubagentState,
} from './types';

export function createSubagentGuardRegistry(): SubagentGuardRegistry {
  const registry = new GuardRegistry<
    SubagentState,
    SubagentGuardConfig,
    SubagentGuardPosition,
    SubagentGuardEffect
  >();
  registry.register(createContextRewriteWatermarkGuard());
  registry.register(createSubagentIterationLimitGuard());
  return registry;
}
