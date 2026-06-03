import { LocalAgentRuntime } from '../runtime';
import { startLocalServer } from '../localServer';
import { config } from '../config';
import { ensureActorSelected } from '../actorSelection';
import { browserSession } from '../plugins/browserSession';

export async function runAgent() {
  await ensureActorSelected({ interactive: true });
  const runtime = new LocalAgentRuntime();

  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) {
      console.log('\n[local-agent] force exit now');
      process.exit(0);
    }
    stopping = true;
    console.log('\n[local-agent] shutting down gracefully...');
    console.log('[local-agent] stopping websocket, finishing current cleanup, then exiting');
    console.log('[local-agent] press Ctrl+C again to force exit immediately');
    runtime.requestStop();
  });

  process.on('SIGTERM', () => {
    runtime.requestStop();
  });

  // Init runtime first to load plugins/llmConfig, then start local server
  const hooks = await runtime.init();
  await startLocalServer(config.localServerPort, {
    actorId: runtime.getActorId(),
    actorName: runtime.getActorName() ?? undefined,
    llmConfig: runtime.getLlmConfig(),
    workdir: config.workdir,
    localTools: runtime.getLocalTools(),
    localToolkitDefinitions: runtime.getLocalToolkitDefinitions(),
    localToolkits: runtime.getLocalToolkits(),
    pluginTools: runtime.getPluginTools(),
    localCapabilityDefinitions: runtime.getLocalCapabilityDefinitions(),
    localCapabilities: runtime.getLocalCapabilities(),
    userCapabilityDefinitions: runtime.getUserCapabilityDefinitions(),
    userCapabilities: runtime.getUserCapabilities(),
    rescanUserCapabilities: () => runtime.rescanUserCapabilities(),
    getStats: () => runtime.getStats(),
  });

  try {
    await runtime.runForever({ skipInit: true });
  } finally {
    await browserSession.close().catch((error) => {
      console.warn('[local-agent] failed to close browser session:', error instanceof Error ? error.message : error);
    });
  }
}
