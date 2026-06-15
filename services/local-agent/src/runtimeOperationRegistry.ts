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
    toolkits: [
      ...(setup.input.toolkits ?? []),
      ...(setup.input.capabilityToolkits ?? []),
    ],
  });
}

export function createOperationRegistryForLocalServerDeps(
  deps: Pick<LocalServerDeps, 'localToolkits' | 'localToolkitDefinitions' | 'localCapabilityToolkits' | 'localCapabilityToolkitDefinitions' | 'pluginToolkits'>,
): OperationRegistry {
  return createOperationRegistryFromSources({
    toolkits: [
      ...(deps.pluginToolkits ?? []),
      ...(deps.localToolkits ?? deps.localToolkitDefinitions ?? []),
      ...(deps.localCapabilityToolkits ?? deps.localCapabilityToolkitDefinitions ?? []),
    ],
  });
}
