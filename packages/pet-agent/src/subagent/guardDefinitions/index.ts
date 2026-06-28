import { GuardRegistry } from '../../guards';
import {
  createContextRewriteWatermarkGuard,
  type ContextRewriteWatermarkGuardOptions,
} from './contextRewriteWatermarkGuard';
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
  type ContextRewriteWatermarkGuardBlockHandler,
  type ContextRewriteWatermarkGuardBlockInput,
  type ContextRewriteWatermarkGuardOptions,
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

export type SubagentGuardRegistryOptions = {
  contextRewrite?: ContextRewriteWatermarkGuardOptions;
};

export function createSubagentGuardRegistry(
  options: SubagentGuardRegistryOptions = {},
): SubagentGuardRegistry {
  const registry = new GuardRegistry<
    SubagentState,
    SubagentGuardConfig,
    SubagentGuardPosition,
    SubagentGuardUpdate
  >();
  if (options.contextRewrite) {
    registry.register(createContextRewriteWatermarkGuard(options.contextRewrite));
  }
  registry.register(createSubagentIterationLimitGuard());
  return registry;
}
