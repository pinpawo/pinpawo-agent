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
import {
  DEFAULT_SERVER_MODE,
  preflightStudioMode,
  type ServerMode,
  type StudioModePreflight,
} from '../serverMode';

export type RunAgentOptions = {
  workdir?: string;
  stdio?: boolean;
  /** #561: one server process has exactly one primary mode. Defaults to chat. */
  mode?: ServerMode;
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
    const mode: ServerMode = options.mode ?? DEFAULT_SERVER_MODE;

    // Studio mode validates its config before any long-lived resource is
    // created, so an invalid Studio setup fails startup instead of silently
    // degrading to chat (#561 design principle 1).
    let studioPreflight: StudioModePreflight | undefined;
    if (mode === 'studio') {
      studioPreflight = await preflightStudioMode(runtimeConfig.workdir, {
        ...(runtimeConfig.studioConfigPath
          ? { studioConfigPath: runtimeConfig.studioConfigPath }
          : {}),
        ...(runtimeConfig.petsDir ? { petsDir: runtimeConfig.petsDir } : {}),
      });
      console.log(
        `[local-agent] studio mode preflight ok studioId=${studioPreflight.studioId} `
        + `planner=${studioPreflight.plannerPetId} `
        + `workers=[${studioPreflight.workerPetIds.join(', ')}]`,
      );
    }

    runtime = new LocalAgentRuntime(runtimeConfig);

    // Init loads Toolkit definitions and starts their optional runtimes before
    // any local transport begins accepting execution requests.
    await runtime.init();
    logStartupConfig({
      mode: 'run',
      serverMode: mode,
      workdir: runtimeConfig.workdir,
      actorId: runtime.getActorId(),
      actorName: runtime.getActorName(),
    });
    const deps: LocalServerDeps = {
      serverMode: mode,
      ...(studioPreflight ? {
        studioMode: {
          studioId: studioPreflight.studioId,
          plannerPetId: studioPreflight.plannerPetId,
          workerPetIds: studioPreflight.workerPetIds,
        },
      } : {}),
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
