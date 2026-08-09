import { LocalAgentRuntime } from '../runtime';
import { startLocalServer } from '../localServer';
import { getConfig } from '../config';
import { ensureActorSelected } from '../actorSelection';
import { applyRuntimeWorkdir } from '../runtimeWorkdir';
import { logStartupConfig } from '../startupConfigLog';
import {
  redirectConsoleToStdioDiagnostics,
  startLocalStdioServer,
} from '../localServerStdioTransport';
import type { LocalServerDeps } from '../localServerTypes';

export type RunAgentOptions = {
  workdir?: string;
  stdio?: boolean;
};

export function buildRunAgentRuntimeConfig(options: RunAgentOptions = {}) {
  return applyRuntimeWorkdir(options.workdir);
}

export async function runAgent(options: RunAgentOptions = {}) {
  const restoreConsole = options.stdio
    ? redirectConsoleToStdioDiagnostics()
    : () => undefined;
  let stopping = false;
  let runtime: LocalAgentRuntime | null = null;
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
    await ensureActorSelected({ interactive: !options.stdio });
    const runtimeConfig = buildRunAgentRuntimeConfig(options);
    runtime = new LocalAgentRuntime(runtimeConfig);

    // Init loads Toolkit definitions and starts their optional runtimes before
    // any local transport begins accepting execution requests.
    await runtime.init();
    logStartupConfig({
      mode: 'run',
      workdir: runtimeConfig.workdir,
      actorId: runtime.getActorId(),
      actorName: runtime.getActorName(),
    });
    const deps: LocalServerDeps = {
      actorId: runtime.getActorId(),
      actorName: runtime.getActorName() ?? undefined,
      modelProfiles: runtime.getModelProfiles(),
      globalReviewPolicyMode: getConfig().globalReviewPolicyMode,
      autoAuthorizationSafetyLevel: getConfig().autoAuthorizationSafetyLevel,
      workdir: runtimeConfig.workdir,
      runtimeConfig,
      localToolkitDefinitions: runtime.getLocalToolkitDefinitions(),
      localToolkits: runtime.getLocalToolkits(),
      pluginToolkitDefinitions: runtime.getPluginToolkitDefinitions(),
      pluginToolkits: runtime.getPluginToolkits(),
      toolkitRuntimeManager: runtime.getToolkitRuntimeManager(),
      localCapabilities: runtime.getLocalCapabilities(),
      userCapabilities: runtime.getUserCapabilities(),
      capabilityArtifactStore: runtime.getCapabilityArtifactStore(),
      rescanUserCapabilities: () => runtime!.rescanUserCapabilities(),
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
