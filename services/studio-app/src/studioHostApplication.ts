import {
  startStudioHostStdio,
  startStudioHostWebSocket,
  type RunningStudioHost,
  type StartStudioHostOptions,
} from '@pinpawo/studio';
import {
  buildLocalAgentRuntimeConfig,
  type LocalAgentRuntimeConfig,
} from 'pinpawo/host-runtime';
import { createStudioModuleResolver } from './moduleCatalog';

export type StudioHostApplicationOptions = {
  workdir?: string;
  transport:
    | { kind: 'stdio' }
    | { kind: 'websocket'; port: number };
};

type SignalTarget = {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
};

export type StudioHostApplicationDependencies = {
  buildRuntimeConfig?: (workdir?: string) => LocalAgentRuntimeConfig;
  createModuleResolver?: typeof createStudioModuleResolver;
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
export async function runStudioHostApplication(
  options: StudioHostApplicationOptions,
  dependencies: StudioHostApplicationDependencies = {},
): Promise<void> {
  const runtimeConfig = (dependencies.buildRuntimeConfig ?? buildLocalAgentRuntimeConfig)(
    options.workdir,
  );
  const resolveModule = (dependencies.createModuleResolver ?? createStudioModuleResolver)({
    workdir: runtimeConfig.workdir,
  });
  const hostOptions: StartStudioHostOptions = {
    runtimeConfig,
    resolveModule,
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
