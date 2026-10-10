import { AgentHost } from '../runtime';
import { startHostServer } from '../server';
import { getConfig } from '../config/config';
import { applyRuntimeWorkdir } from '../config/runtimeWorkdir';
import { logStartupConfig } from '../config/startupConfigLog';
import {
  redirectConsoleToStdioDiagnostics,
} from '../wire/stdioTransport';
import { startLocalStdioServer } from '../chatStdioServer';

export type RunAgentOptions = {
  workdir?: string;
  stdio?: boolean;
};

export function buildRunAgentRuntimeConfig(options: Pick<RunAgentOptions, 'workdir'>) {
  return applyRuntimeWorkdir(options.workdir);
}

export async function runAgent(options: RunAgentOptions) {
  const restoreConsole = options.stdio
    ? redirectConsoleToStdioDiagnostics()
    : () => undefined;
  let stopping = false;
  let runtime: AgentHost | null = null;
  let closeLocalTransport: (() => void) | null = null;
  const handleSigint = () => {
    if (stopping) {
      console.log('\n[host] force exit now');
      process.exit(0);
    }
    stopping = true;
    console.log('\n[host] shutting down gracefully...');
    console.log(options.stdio
      ? '[host] closing stdio peer, finishing current cleanup, then exiting'
      : '[host] stopping websocket, finishing current cleanup, then exiting');
    console.log('[host] press Ctrl+C again to force exit immediately');
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

    // AgentHost shares capability supply via HostCapabilityAssembly and
    // adds Chat/ws-relay concerns on top.
    runtime = new AgentHost(runtimeConfig);

    // Init loads Toolkit definitions and starts their optional runtimes before
    // any local transport begins accepting execution requests.
    await runtime.init();
    logStartupConfig({
      mode: 'server',
      workdir: runtimeConfig.workdir,
      petId: runtime.getPetConfig().petId,
      petName: runtime.getPetConfig().name,
    });
    const deps = runtime.buildChatHostDeps();

    if (stopping) {
      runtime.requestStop();
      return;
    }

    if (options.stdio) {
      const transport = startLocalStdioServer(deps);
      closeLocalTransport = transport.close;
      console.log('[chat-host] stdio JSONL transport ready');
      await transport.closed;
      runtime.requestStop();
    } else {
      const transport = await startHostServer(getConfig().hostPort, deps);
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
      console.warn('[host] failed to stop Toolkit runtimes:', error instanceof Error ? error.message : error);
    });
    restoreConsole();
  }
}
