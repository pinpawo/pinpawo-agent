import { LocalAgentRuntime } from '../runtime';
import { startLocalServer } from '../localServer';
import { getConfig } from '../config';
import { ensureActorSelected } from '../actorSelection';
import { browserSession } from '../toolkits/browser';
import { localAgentBrowserBridge } from '../toolkits/browser/localAgentBrowserBridge';
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
  let browserBridgeStarted = false;
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

    if (getConfig().browserBackend === 'extension') {
      await localAgentBrowserBridge.start();
      browserBridgeStarted = true;
    }

    // Init runtime first to load plugins and the effective LLM config.
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
      llmConfig: runtime.getLlmConfig(),
      workdir: runtimeConfig.workdir,
      runtimeConfig,
      localToolkitDefinitions: runtime.getLocalToolkitDefinitions(),
      localToolkits: runtime.getLocalToolkits(),
      pluginToolkits: runtime.getPluginToolkits(),
      localCapabilityDefinitions: runtime.getLocalCapabilityDefinitions(),
      localCapabilities: runtime.getLocalCapabilities(),
      userCapabilityDefinitions: runtime.getUserCapabilityDefinitions(),
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
      await startLocalServer(getConfig().localServerPort, deps);
      await runtime.runForever({ skipInit: true });
    }
  } finally {
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);
    closeLocalTransport?.();
    runtime?.requestStop();
    await browserSession.close().catch((error) => {
      console.warn('[local-agent] failed to close browser session:', error instanceof Error ? error.message : error);
    });
    if (browserBridgeStarted) {
      await localAgentBrowserBridge.stop().catch((error) => {
        console.warn('[local-agent] failed to stop browser bridge:', error instanceof Error ? error.message : error);
      });
    }
    restoreConsole();
  }
}
