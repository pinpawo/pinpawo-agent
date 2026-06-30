import type { RunnableConfig } from '@langchain/core/runnables';
import type { GuardRunOptions } from '../../../../guards';
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
    contextCompaction: {
      contextWindowTokens: params.config.contextWindowTokens,
    },
    forcedCapabilityNames: invokeOptions.forcedCapabilityNames,
    runIterationLimit: invokeOptions.maxRunIterations ?? params.orchestratorMaxIterations,
  };
}

export function createOrchestratorGuardRunner(params: {
  config: OrchestratorConfig;
  orchestratorMaxIterations: number;
  guardRegistry: OrchestratorGuardRegistry;
}): OrchestratorGuardRunner {
  return async function runOrchestratorGuard(
    name,
    position,
    state,
    runnableConfig,
    runOptions,
  ) {
    const { update } = await params.guardRegistry.run(name, {
      state,
      config: buildGuardConfig({
        config: params.config,
        orchestratorMaxIterations: params.orchestratorMaxIterations,
        runnableConfig,
      }),
      position,
    }, runOptions);
    return update ?? {};
  };
}

export { createOrchestratorGuardRegistry };
