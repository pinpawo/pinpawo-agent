import {
  buildLocalAgentRuntimeConfig,
  type LocalAgentRuntimeConfig,
} from 'pinpawo/host-runtime';
import {
  startResidentPetAgentSessionTransport,
  type ResidentPetAgentSessionTransportOptions,
} from 'pinpawo/local-server-transport';
import { StudioHost, type StudioHostOptions } from './host/StudioHost';

export type StartStudioHostOptions = Omit<StudioHostOptions, 'runtimeConfig'> & {
  workdir?: string;
  runtimeConfig?: LocalAgentRuntimeConfig;
  /** Local-agent Agent Session listener; 0 selects an available loopback port. */
  agentSessionPort?: number;
  agentSessionTransport?: ResidentPetAgentSessionTransportOptions;
  /** Composition hook for deterministic lifecycle tests and embedded Hosts. */
  startAgentSessionTransport?: typeof startResidentPetAgentSessionTransport;
};

export type RunningStudioHost = {
  host: StudioHost;
  agentSessionPort: number;
  closed: Promise<void>;
  close: () => void;
};

function createHost(options: StartStudioHostOptions) {
  const runtimeConfig = options.runtimeConfig
    ?? buildLocalAgentRuntimeConfig(options.workdir);
  return new StudioHost({
    runtimeConfig,
    ...(options.resolvePlugin ? { resolvePlugin: options.resolvePlugin } : {}),
    ...(options.capabilityAssembly
      ? { capabilityAssembly: options.capabilityAssembly }
      : {}),
    ...(options.resolveStudioHostConfig
      ? { resolveStudioHostConfig: options.resolveStudioHostConfig }
      : {}),
    ...(options.buildStudio ? { buildStudio: options.buildStudio } : {}),
  });
}

async function initializeHost(options: StartStudioHostOptions) {
  const host = createHost(options);
  await host.init();
  return host;
}

/**
 * Start the resident Host and its local-agent conversation listener.
 * Studio dispatch/event HTTP is started only by configured Studio Plugins.
 */
export async function startStudioHost(
  options: StartStudioHostOptions = {},
): Promise<RunningStudioHost> {
  const host = await initializeHost(options);
  try {
    const transport = await (options.startAgentSessionTransport
      ?? startResidentPetAgentSessionTransport)(
      options.agentSessionPort ?? 0,
      host.getResidentPetInteractions(),
      options.agentSessionTransport,
    );
    const closed = transport.closed.finally(() => host.shutdown());
    return {
      host,
      agentSessionPort: transport.port,
      close: transport.close,
      closed,
    };
  } catch (error) {
    await host.shutdown().catch(() => undefined);
    throw error;
  }
}
