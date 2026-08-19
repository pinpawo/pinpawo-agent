import { LocalAgentHost } from '../runtime';
import { StudioHost } from '../studioHost';
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
import { LocalServerStudioHandler } from '../localServerStudioHandler';
import {
  preflightStudioMode,
  type ServerMode,
  type StudioModePreflight,
} from '../serverMode';
import { sendLocalServerPeerEvent, type LocalServerPeer } from '../localServerPeer';

export type RunAgentOptions = {
  workdir?: string;
  stdio?: boolean;
  /** #561: one server process has exactly one primary mode. */
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
  let studioHost: StudioHost | null = null;
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
    studioHost?.requestStop();
    closeLocalTransport?.();
  };
  const handleSigterm = () => {
    stopping = true;
    runtime?.requestStop();
    studioHost?.requestStop();
    closeLocalTransport?.();
  };
  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', handleSigterm);

  try {
    await ensureActorSelected({ interactive: !options.stdio });
    const runtimeConfig = buildRunAgentRuntimeConfig(options);
    const mode = options.mode;

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
        + `entry=${studioPreflight.entryPetId} `
        + `pets=[${studioPreflight.petIds.join(', ')}]`,
      );
    }

    // #643: Chat and Studio use separate Host entry points.
    // Chat mode → LocalAgentHost; Studio mode → StudioHost.
    if (mode === 'studio') {
      studioHost = new StudioHost({
        runtimeConfig,
        studioMode: studioPreflight
          ? {
              studioId: studioPreflight.studioId,
              entryPetId: studioPreflight.entryPetId,
              petIds: studioPreflight.petIds,
            }
          : undefined,
      });

      await studioHost.init();
      logStartupConfig({
        mode: 'server',
        serverMode: mode,
        workdir: runtimeConfig.workdir,
        actorId: studioHost.getActorId(),
        actorName: studioHost.getActorName(),
      });

      // Studio host creates its own studio handler with the resident Studio
      // built during init(). The handler only dispatches to this Studio.
      const studioHandler = new LocalServerStudioHandler<LocalServerPeer>({
        outbound: {
          sendMessage: (peer, message) => peer.send(message),
          sendEvent: (peer, event) => sendLocalServerPeerEvent(peer, event),
        },
        studio: studioHost.getStudio(),
      });
      const deps: LocalServerDeps = studioHost.buildLocalServerDeps();

      if (stopping) {
        studioHost.requestStop();
        return;
      }

      if (options.stdio) {
        const transport = startLocalStdioServer(deps, { studioHandler });
        closeLocalTransport = transport.close;
        console.log('[local-server] stdio JSONL transport ready');
        await transport.closed;
        studioHost.requestStop();
      } else {
        const transport = await startLocalServer(getConfig().localServerPort, deps, {
          studioHandler,
        });
        closeLocalTransport = transport.close;
        try {
          // Studio host doesn't run a ws relay loop; keep process alive
          // via the transport's closed promise.
          await transport.closed;
        } finally {
          transport.close();
          await transport.closed;
          closeLocalTransport = null;
        }
      }
    } else {
      // Chat mode: LocalAgentHost shares capability supply via
// HostCapabilityAssembly; adds chat/ws-relay concerns on top.
      runtime = new LocalAgentHost(runtimeConfig, mode);

      // Init loads Toolkit definitions and starts their optional runtimes before
      // any local transport begins accepting execution requests.
      await runtime.init();
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
    }
  } finally {
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);
    closeLocalTransport?.();
    await runtime?.shutdown().catch((error) => {
      console.warn('[local-agent] failed to stop Toolkit runtimes:', error instanceof Error ? error.message : error);
    });
    await studioHost?.shutdown().catch((error) => {
      console.warn('[studio-host] failed to stop:', error instanceof Error ? error.message : error);
    });
    restoreConsole();
  }
}
