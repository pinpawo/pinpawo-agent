import { hasToolOperationMetadata } from '@pinpawo/pet-agent';
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
    legacyRuntimeOperations: hasToolOperationMetadata(setup.input.legacyToolOperations)
      ? setup.input.legacyToolOperations
      : undefined,
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
