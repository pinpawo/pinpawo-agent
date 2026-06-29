import { GuardRegistry } from '../../guards';
import { createContextRewriteWatermarkGuard } from './contextRewriteWatermarkGuard';
import { createSubagentIterationLimitGuard } from './iterationLimitGuard';
import {
  type SubagentGuardConfig,
  type SubagentGuardPosition,
  type SubagentGuardRegistry,
  type SubagentState,
  type SubagentGuardUpdate,
} from './types';

export {
  createContextRewriteWatermarkGuard,
} from './contextRewriteWatermarkGuard';
export { createSubagentIterationLimitGuard } from './iterationLimitGuard';
export {
  SUBAGENT_GUARD_NAME,
  SUBAGENT_GUARD_POSITION,
  type SubagentGuard,
  type SubagentGuardConfig,
  type SubagentGuardName,
  type SubagentGuardPosition,
  type SubagentGuardRegistry,
  type SubagentState,
  type SubagentGuardUpdate,
} from './types';

export function createSubagentGuardRegistry(): SubagentGuardRegistry {
  const registry = new GuardRegistry<
    SubagentState,
    SubagentGuardConfig,
    SubagentGuardPosition,
    SubagentGuardUpdate
  >();
  registry.register(createContextRewriteWatermarkGuard());
  registry.register(createSubagentIterationLimitGuard());
  return registry;
}
