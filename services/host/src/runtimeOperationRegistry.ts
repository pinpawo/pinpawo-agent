import type { AgentChannelSetup } from './agent/agentChannel';
import {
  getToolkitInventory,
  type ServerDeps,
} from './serverTypes';
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

export function createOperationRegistryForDeps(
  deps: Pick<ServerDeps, 'toolkitInventory'>,
): OperationRegistry {
  const toolkitInventory = getToolkitInventory(deps);
  return createOperationRegistryFromSources({
    toolkits: [...toolkitInventory.effectiveToolkits],
  });
}
