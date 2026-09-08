import type { AgentChannelSetup } from './agentChannel';
import {
  getLocalServerToolkitInventory,
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

export function createOperationRegistryForLocalServerDeps(
  deps: Pick<ServerDeps, 'toolkitInventory'>,
): OperationRegistry {
  const toolkitInventory = getLocalServerToolkitInventory(deps);
  return createOperationRegistryFromSources({
    toolkits: [...toolkitInventory.effectiveToolkits],
  });
}
