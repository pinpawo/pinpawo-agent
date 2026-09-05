import { LocalAgentHost } from '../runtime';
import { startLocalServer } from '../localServer';
import { getConfig } from '../config';
import { applyRuntimeWorkdir } from '../runtimeWorkdir';
import { logStartupConfig } from '../startupConfigLog';
import {
  redirectConsoleToStdioDiagnostics,
} from '../localServerStdioTransport';
import { startLocalStdioServer } from '../chatStdioServer';
import type { LocalServerDeps } from '../localServerTypes';
import type { ServerMode } from '../serverMode';

export type RunAgentOptions = {
  workdir?: string;
  stdio?: boolean;
  /** Local-agent is the Chat Host; retained in runtime projections as a literal. */
  mode: ServerMode;
};

export function buildRunAgentRuntimeConfig(options: Pick<RunAgentOptions, 'workdir'>) {
  return applyRuntimeWorkdir(options.workdir);
}

export async function runAgent(options: RunAgentOptions) {
  const restoreConsole = options.stdio
    ? redirectConsoleToStdioDiagnostics()
    : () => undefined;
  let stopping = false;
  let runtime: LocalAgentHost | null = null;
  let closeLocalTransport: (() => void) | null = null;
  const handleSigint = () => {
    if (stopping) {
      console.log('\n[local-agent] force exit now');
      process.exit(0);
    }
    stopping = true;
    console.log('\n[local-agent] shutting down gracefully...');
    console.log(options.stdio
      ? '[local-agent] closing stdio peer, finishing current cleanup, then exiting'
      : '[local-agent] stopping websocket, finishing current cleanup, then exiting');
    console.log('[local-agent] press Ctrl+C again to force exit immediately');
    runtime?.requestStop();
    closeLocalTransport?.();
  };
  const handleSigterm = () => {
    stopping = true;
    runtime?.requestStop();
    closeLocalTransport?.();
  };
  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', handleSigterm);

  try {
    const runtimeConfig = buildRunAgentRuntimeConfig(options);
    const mode = options.mode;

    // LocalAgentHost shares capability supply via HostCapabilityAssembly and
    // adds Chat/ws-relay concerns on top.
    runtime = new LocalAgentHost(runtimeConfig, mode);

    // Init loads Toolkit definitions and starts their optional runtimes before
    // any local transport begins accepting execution requests.
    await runtime.init();
    const petDocument = runtime.getPetDocument();
    logStartupConfig({
      mode: 'server',
      serverMode: mode,
      workdir: runtimeConfig.workdir,
      actorId: runtime.getActorId(),
      actorName: runtime.getActorName(),
    });
    const deps: LocalServerDeps = {
      serverMode: mode,
      actorId: runtime.getActorId(),
      actorName: runtime.getActorName() ?? undefined,
      chatCheckpointer: runtime.getChatCheckpointer(),
      modelProfiles: runtime.getModelProfiles(),
      globalReviewPolicyMode: getConfig().globalReviewPolicyMode,
      autoAuthorizationSafetyLevel: getConfig().autoAuthorizationSafetyLevel,
      workdir: runtimeConfig.workdir,
      runtimeConfig,
      toolkitInventory: runtime.getToolkitInventoryStore(),
      toolkitRuntimeManager: runtime.getToolkitRuntimeManager(),
      capabilityCatalog: runtime.getCapabilityCatalog(),
      ...(petDocument ? { petDocument } : {}),
      capabilityArtifactStore: runtime.getCapabilityArtifactStore(),
    };

    if (stopping) {
      runtime.requestStop();
      return;
    }

    if (options.stdio) {
      const transport = startLocalStdioServer(deps);
      closeLocalTransport = transport.close;
      console.log('[local-server] stdio JSONL transport ready');
      await transport.closed;
      runtime.requestStop();
    } else {
      const transport = await startLocalServer(getConfig().localServerPort, deps);
      closeLocalTransport = transport.close;
      try {
        await runtime.runForever({ skipInit: true });
      } finally {
        transport.close();
        await transport.closed;
        closeLocalTransport = null;
      }
    }
  } finally {
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);
    closeLocalTransport?.();
    await runtime?.shutdown().catch((error) => {
      console.warn('[local-agent] failed to stop Toolkit runtimes:', error instanceof Error ? error.message : error);
    });
    restoreConsole();
  }
}
