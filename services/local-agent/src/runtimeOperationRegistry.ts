import type { AgentChannelSetup } from './agentChannel';
import type { LocalServerDeps } from './localServerTypes';
import {
  createOperationRegistryFromToolkits,
  type OperationRegistry,
} from './events/operationRegistry';

export function createOperationRegistryForAgentSetup(
  setup: Pick<AgentChannelSetup, 'input'>,
): OperationRegistry {
  return createOperationRegistryFromToolkits(setup.input.toolkits ?? []);
}

export function createOperationRegistryForLocalServerDeps(
  deps: Pick<LocalServerDeps, 'localToolkits' | 'localToolkitDefinitions'>,
): OperationRegistry {
  return createOperationRegistryFromToolkits(
    deps.localToolkits ?? deps.localToolkitDefinitions ?? [],
  );
}
