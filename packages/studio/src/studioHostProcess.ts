import {
  buildLocalAgentRuntimeConfig,
  type LocalAgentRuntimeConfig,
} from 'pinpawo/host-runtime';
import { ensureLocalServerAuthToken } from 'pinpawo/local-server-transport';
import type { StudioPluginResolver } from './host/buildStudio';
import { createInstalledStudioPluginResolver } from './installedPluginResolver';
import {
  startStudioHost,
  type RunningStudioHost,
  type StartStudioHostOptions,
} from './startStudioHost';

export type StudioHostProcessOptions = {
  workdir?: string;
  resolvePlugin?: StudioPluginResolver;
  agentSessionPort?: number;
};

type SignalTarget = {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
};

export type StudioHostProcessDependencies = {
  buildRuntimeConfig?: (workdir?: string) => LocalAgentRuntimeConfig;
  ensureAuthToken?: () => string;
  createPluginResolver?: typeof createInstalledStudioPluginResolver;
  startHost?: (
    options: StartStudioHostOptions,
  ) => Promise<RunningStudioHost>;
  signals?: SignalTarget;
};

/** Start one standalone Studio Host and own its process signal boundary. */
export async function runStudioHostProcess(
  options: StudioHostProcessOptions,
  dependencies: StudioHostProcessDependencies = {},
): Promise<void> {
  const runtimeConfig = (dependencies.buildRuntimeConfig ?? buildLocalAgentRuntimeConfig)(
    options.workdir,
  );
  const authToken = (dependencies.ensureAuthToken ?? ensureLocalServerAuthToken)();
  const resolvePlugin = options.resolvePlugin
    ?? (dependencies.createPluginResolver ?? createInstalledStudioPluginResolver)({
      workdir: runtimeConfig.workdir,
    });
  const hostOptions: StartStudioHostOptions = {
    runtimeConfig,
    resolvePlugin,
    agentSessionTransport: { authToken },
    ...(options.agentSessionPort !== undefined
      ? { agentSessionPort: options.agentSessionPort }
      : {}),
  };
  const signals = dependencies.signals ?? process;
  let closeRequested = false;
  let running: RunningStudioHost | undefined;
  const requestClose = () => {
    if (closeRequested) return;
    closeRequested = true;
    running?.close();
  };
  signals.once('SIGINT', requestClose);
  signals.once('SIGTERM', requestClose);
  try {
    running = await (dependencies.startHost ?? startStudioHost)(hostOptions);
    if (closeRequested) running.close();
    await running.closed;
  } finally {
    signals.off('SIGINT', requestClose);
    signals.off('SIGTERM', requestClose);
  }
}
