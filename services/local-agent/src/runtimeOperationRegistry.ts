import type { AgentChannelSetup } from './agentChannel';
import {
  getLocalServerToolkitInventory,
  type LocalServerDeps,
} from './localServerTypes';
import {
  createOperationRegistryFromSources,
  type OperationRegistry,
} from './events/operationRegistry';

export function createOperationRegistryForAgentSetup(
  setup: Pick<AgentChannelSetup, 'input'>,
): OperationRegistry {
  return createOperationRegistryFromSources({
    toolkits: setup.input.toolkits ?? [],
  });
}

export function createOperationRegistryForLocalServerDeps(
  deps: Pick<LocalServerDeps, 'toolkitInventory'>,
): OperationRegistry {
  const toolkitInventory = getLocalServerToolkitInventory(deps);
  return createOperationRegistryFromSources({
    toolkits: [...toolkitInventory.effectiveToolkits],
  });
}
