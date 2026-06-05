import type { AgentChannelSetup } from './agentChannel';
import type { LocalServerDeps } from './localServerTypes';
import {
  createOperationRegistryFromSources,
  type OperationRegistry,
} from './events/operationRegistry';

export function createOperationRegistryForAgentSetup(
  setup: Pick<AgentChannelSetup, 'input'>,
): OperationRegistry {
  return createOperationRegistryFromSources({
    toolkits: setup.input.toolkits ?? [],
    legacyRuntimeOperations: setup.input.toolOperations,
  });
}

export function createOperationRegistryForLocalServerDeps(
  deps: Pick<LocalServerDeps, 'localToolkits' | 'localToolkitDefinitions' | 'pluginToolkits'>,
): OperationRegistry {
  return createOperationRegistryFromSources({
    toolkits: [
      ...(deps.pluginToolkits ?? []),
      ...(deps.localToolkits ?? deps.localToolkitDefinitions ?? []),
    ],
  });
}
