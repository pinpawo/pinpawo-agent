import {
  buildLocalAgentRuntimeConfig,
  type LocalAgentRuntimeConfig,
} from 'pinpawo/host-runtime';
import {
  redirectConsoleToStdioDiagnostics,
  type LocalServerStdioTransportOptions,
  type LocalServerTransportOptions,
} from 'pinpawo/local-server-transport';
import { StudioHost, type StudioHostOptions } from './host/StudioHost';
import {
  startStudioStdioTransport,
  startStudioWebSocketTransport,
} from './transport/startStudioTransport';

export type StartStudioHostOptions = Omit<StudioHostOptions, 'runtimeConfig'> & {
  workdir?: string;
  runtimeConfig?: LocalAgentRuntimeConfig;
};

export type RunningStudioHost = {
  host: StudioHost;
  closed: Promise<void>;
  close: () => void;
};

function createHost(options: StartStudioHostOptions) {
  const runtimeConfig = options.runtimeConfig
    ?? buildLocalAgentRuntimeConfig(options.workdir);
  return new StudioHost({
    runtimeConfig,
    ...(options.resolveModule ? { resolveModule: options.resolveModule } : {}),
    ...(options.capabilityAssembly
      ? { capabilityAssembly: options.capabilityAssembly }
      : {}),
    ...(options.buildStudio ? { buildStudio: options.buildStudio } : {}),
  });
}

async function initializeHost(options: StartStudioHostOptions) {
  const host = createHost(options);
  await host.init();
  return host;
}

function ownHostLifecycle(
  host: StudioHost,
  transport: { close: () => void; closed: Promise<void> },
  afterShutdown?: () => void,
): RunningStudioHost {
  let shutdown: Promise<void> | undefined;
  const shutdownHost = () => {
    shutdown ??= host.shutdown();
    return shutdown;
  };
  return {
    host,
    close: transport.close,
    closed: transport.closed.finally(async () => {
      try {
        await shutdownHost();
      } finally {
        afterShutdown?.();
      }
    }),
  };
}

/** Start an independent resident Studio Host over newline-delimited stdio. */
export async function startStudioHostStdio(
  options: StartStudioHostOptions = {},
  transportOptions: LocalServerStdioTransportOptions = {},
): Promise<RunningStudioHost> {
  const restoreConsole = redirectConsoleToStdioDiagnostics(transportOptions.diagnostics);
  let host: StudioHost | undefined;
  try {
    // Redirect before Host initialization: plugin/capability startup logs are
    // diagnostics too and must never corrupt JSONL protocol stdout.
    host = await initializeHost(options);
    const runtimeConfig = host.getRuntimeConfig();
    const transport = startStudioStdioTransport({
      studio: host.getStudio(),
      workdir: runtimeConfig.workdir,
    }, transportOptions);
    return ownHostLifecycle(host, transport, restoreConsole);
  } catch (error) {
    await host?.shutdown().catch(() => undefined);
    restoreConsole();
    throw error;
  }
}

/** Start an independent resident Studio Host over loopback HTTP/WebSocket. */
export async function startStudioHostWebSocket(
  port: number,
  options: StartStudioHostOptions = {},
  transportOptions: Omit<LocalServerTransportOptions, 'closeHandlers'> = {},
): Promise<RunningStudioHost> {
  const host = await initializeHost(options);
  try {
    const runtimeConfig = host.getRuntimeConfig();
    const transport = await startStudioWebSocketTransport(port, {
      studio: host.getStudio(),
      workdir: runtimeConfig.workdir,
    }, transportOptions);
    return ownHostLifecycle(host, transport);
  } catch (error) {
    await host.shutdown().catch(() => undefined);
    throw error;
  }
}
