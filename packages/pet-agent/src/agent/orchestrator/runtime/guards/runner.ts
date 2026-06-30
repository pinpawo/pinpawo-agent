import type { RunnableConfig } from '@langchain/core/runnables';
import {
  createGuardRunner,
  type GuardRunOptions,
} from '../../../../guards';
import type {
  OrchestratorControlContext,
  OrchestratorStatePatch,
} from '../../controlPrimitives';
import {
  createOrchestratorGuardRegistry,
  type OrchestratorGuardConfig,
  type OrchestratorGuardName,
  type OrchestratorGuardPosition,
} from '../../guardDefinitions';
import type { OrchestratorStateType } from '../../state';
import type { OrchestratorConfig } from '../../types';
import { getInvokeOptions } from '../config';

export type OrchestratorGuardRegistry = ReturnType<typeof createOrchestratorGuardRegistry>;

export type OrchestratorGuardRunner = (
  name: OrchestratorGuardName,
  position: OrchestratorGuardPosition,
  state: OrchestratorStateType,
  runnableConfig?: RunnableConfig,
  runOptions?: OrchestratorGuardRunOptions,
) => Promise<OrchestratorStatePatch>;

type OrchestratorGuardRunOptions = GuardRunOptions<
  OrchestratorStateType,
  OrchestratorGuardConfig,
  OrchestratorGuardPosition,
  OrchestratorStatePatch
>;

type OrchestratorNodeGuardRuntimeInput = {
  state: OrchestratorStateType;
  runnableConfig?: RunnableConfig;
};

export function createControlContextBuilder(orchestratorMaxIterations: number) {
  return function buildControlContext(runnableConfig?: RunnableConfig): OrchestratorControlContext {
    return { runnableConfig, orchestratorMaxIterations };
  };
}

function buildGuardConfig(params: {
  config: OrchestratorConfig;
  orchestratorMaxIterations: number;
  runnableConfig?: RunnableConfig;
}): OrchestratorGuardConfig {
  const invokeOptions = getInvokeOptions(params.runnableConfig);
  return {
    capabilities: invokeOptions.capabilities ?? [],
    contextWindowTokens: params.config.contextWindowTokens,
    forcedCapabilityNames: invokeOptions.forcedCapabilityNames,
    runIterationLimit: invokeOptions.maxRunIterations ?? params.orchestratorMaxIterations,
  };
}

export function createOrchestratorGuardRunner(params: {
  config: OrchestratorConfig;
  orchestratorMaxIterations: number;
  guardRegistry: OrchestratorGuardRegistry;
}): OrchestratorGuardRunner {
  const runGuard = createGuardRunner<
    OrchestratorGuardName,
    OrchestratorStateType,
    OrchestratorGuardConfig,
    OrchestratorGuardPosition,
    OrchestratorStatePatch,
    OrchestratorNodeGuardRuntimeInput
  >({
    registry: params.guardRegistry,
    adapter: {
      toGuardInput: (position, input) => ({
        state: input.state,
        config: buildGuardConfig({
          config: params.config,
          orchestratorMaxIterations: params.orchestratorMaxIterations,
          runnableConfig: input.runnableConfig,
        }),
        position,
      }),
    },
  });

  return async function runOrchestratorGuard(
    name,
    position,
    state,
    runnableConfig,
    runOptions,
  ) {
    const { update } = await runGuard(
      name,
      position,
      {
        state,
        runnableConfig,
      },
      runOptions,
    );
    return update ?? {};
  };
}

export { createOrchestratorGuardRegistry };
