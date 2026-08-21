import {
  buildLocalAgentRuntimeConfig,
  type LocalAgentRuntimeConfig,
} from 'pinpawo/host-runtime';
import type { StudioModuleResolver } from './host/buildStudio';
import {
  startStudioHostStdio,
  startStudioHostWebSocket,
  type RunningStudioHost,
  type StartStudioHostOptions,
} from './startStudioHost';

export type StudioHostProcessOptions = {
  workdir?: string;
  resolveModule?: StudioModuleResolver;
  transport:
    | { kind: 'stdio' }
    | { kind: 'websocket'; port: number };
};

type SignalTarget = {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
};

export type StudioHostProcessDependencies = {
  buildRuntimeConfig?: (workdir?: string) => LocalAgentRuntimeConfig;
  startStdio?: (
    options: StartStudioHostOptions,
  ) => Promise<RunningStudioHost>;
  startWebSocket?: (
    port: number,
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
  const hostOptions: StartStudioHostOptions = {
    runtimeConfig,
    ...(options.resolveModule ? { resolveModule: options.resolveModule } : {}),
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
    running = options.transport.kind === 'stdio'
      ? await (dependencies.startStdio ?? startStudioHostStdio)(hostOptions)
      : await (dependencies.startWebSocket ?? startStudioHostWebSocket)(
        options.transport.port,
        hostOptions,
      );
    if (closeRequested) running.close();
    await running.closed;
  } finally {
    signals.off('SIGINT', requestClose);
    signals.off('SIGTERM', requestClose);
  }
}
