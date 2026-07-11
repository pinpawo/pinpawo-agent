import { LocalAgentRuntime } from '../runtime';
import { startLocalServer } from '../localServer';
import { getConfig } from '../config';
import { ensureActorSelected } from '../actorSelection';
import { browserSession } from '../toolkits/browser';
import { applyRuntimeWorkdir } from '../runtimeWorkdir';

export type RunAgentOptions = {
  workdir?: string;
};

export function buildRunAgentRuntimeConfig(options: RunAgentOptions = {}) {
  return applyRuntimeWorkdir(options.workdir);
}

export async function runAgent(options: RunAgentOptions = {}) {
  await ensureActorSelected({ interactive: true });
  const runtimeConfig = buildRunAgentRuntimeConfig(options);
  const runtime = new LocalAgentRuntime(runtimeConfig);

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
  await startLocalServer(getConfig().localServerPort, {
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
    rescanUserCapabilities: () => runtime.rescanUserCapabilities(),
  });

  try {
    await runtime.runForever({ skipInit: true });
  } finally {
    await browserSession.close().catch((error) => {
      console.warn('[local-agent] failed to close browser session:', error instanceof Error ? error.message : error);
    });
  }
}
