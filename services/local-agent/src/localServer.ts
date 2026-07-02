/**
 * Local WebSocket server for TUI ↔ run process communication.
 *
 * Runs inside the `run` process. TUI connects via ws://127.0.0.1:<port>.
 * Protocol matches the App WS relay format so both paths share the same
 * message types.
 */
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { WebSocket } from 'ws';
import { FileStudioDueRunStore } from '@pinpawo/pet-agent';
import { config } from './config';
import { FileCapabilityArtifactStore } from './capabilityArtifactStore';
import { LocalAgentGraphService } from './agentGraphService';
import {
  sendLocalAgentEvent,
  sendLocalAgentMessage,
} from './localAgentProtocol';
import { InflightRequestController } from './inflightRequestController';
import { LocalServerStudioReviewRouter } from './localServerStudioReviews';
import { LocalStudioDueRunScheduler } from './localStudioDueRunScheduler';
import { LocalServerTuiSessionService } from './localServerTuiSessions';
import { handleLocalHttpRequest } from './localHttpHandlers';
import { attachLocalServerWebSocketTransport } from './localServerWsTransport';
import { ensureLocalServerAuthToken } from './localServerAuth';
import { LocalServerChatHandler } from './localServerChatHandler';
import { LocalServerStudioHandler } from './localServerStudioHandler';
import { buildLocalServerTuiSnapshot } from './localServerTuiSnapshot';
import type { LocalServerDeps } from './localServerTypes';
import { buildWorkspaceRuntimeConfig } from './runtimeConfig';
import type { LocalAgentRuntimeConfig } from './runtimeConfig';
import { setLocalToolsWorkdir } from './toolkits/local/pathUtils';
import type { WorkspaceRegistryEntry } from './workspaceRegistry';

export type { LocalServerDeps };

const INTERRUPT_FORCE_REPLY_MS = 1800;

function createStudioDueRunScheduler(runtimeConfig: LocalAgentRuntimeConfig) {
  return new LocalStudioDueRunScheduler({
    store: new FileStudioDueRunStore({
      filePath: runtimeConfig.studioDueRunsPath,
    }),
    filterWorkdir: runtimeConfig.workdir,
  });
}

export function startLocalServer(port: number, deps: LocalServerDeps): Promise<void> {
  return new Promise((resolve, reject) => {
    const effectiveRuntimeConfig = deps.runtimeConfig ?? buildWorkspaceRuntimeConfig({
      workdir: deps.workdir,
    });
    let activeStudioDueRunScheduler = deps.studioDueRunScheduler
      ?? createStudioDueRunScheduler(effectiveRuntimeConfig);
    const depsWithRuntime: LocalServerDeps = {
      ...deps,
      workdir: effectiveRuntimeConfig.workdir,
      runtimeConfig: effectiveRuntimeConfig,
      studioDueRunScheduler: activeStudioDueRunScheduler,
    };
    const chatGraphService = new LocalAgentGraphService();
    const tuiSessions = new LocalServerTuiSessionService({
      graphService: chatGraphService,
      runtimeConfig: effectiveRuntimeConfig,
    });
    const studioReviewRouter = new LocalServerStudioReviewRouter<WebSocket>();
    const switchWorkspace = (workspace: WorkspaceRegistryEntry) => {
      const runtimeConfig = buildWorkspaceRuntimeConfig({
        workdir: realpathSync(workspace.rootPath),
        workspaceId: workspace.id,
        workspaceName: workspace.name,
      });
      if (!deps.studioDueRunScheduler) {
        activeStudioDueRunScheduler.stop();
        activeStudioDueRunScheduler = createStudioDueRunScheduler(runtimeConfig);
        depsWithRuntime.studioDueRunScheduler = activeStudioDueRunScheduler;
      }
      process.chdir(runtimeConfig.workdir);
      config.workdir = runtimeConfig.workdir;
      setLocalToolsWorkdir(runtimeConfig.workdir);
      depsWithRuntime.workdir = runtimeConfig.workdir;
      depsWithRuntime.runtimeConfig = runtimeConfig;
      depsWithRuntime.capabilityArtifactStore = new FileCapabilityArtifactStore(
        runtimeConfig.capabilityArtifactRoot,
      );
      tuiSessions.switchRuntimeConfig(runtimeConfig);
      tuiSessions.getActiveSession(depsWithRuntime.actorId);
      console.log(`[local-server] switched workspace to ${runtimeConfig.workdir}`);
      return {
        workspace: {
          ...workspace,
          name: runtimeConfig.workspace?.name ?? workspace.name,
          rootPath: runtimeConfig.workdir,
        },
        runtimeConfig,
        requiresRestart: false,
      };
    };
    depsWithRuntime.switchWorkspace = deps.switchWorkspace ?? switchWorkspace;
    const inflightRequests = new InflightRequestController<WebSocket>({
      forceInterruptMs: INTERRUPT_FORCE_REPLY_MS,
      // Local TUI / companion: trusted transport — forward raw input/output so
      // the UI can render diffs, expand payloads, etc.
      emitOperation: (ws, event) => sendLocalAgentEvent(ws, event, { includeRaw: true }),
      sendControl: (ws, message) => sendLocalAgentMessage(ws, message),
      logPrefix: 'local-server',
    });
    const chatHandler = new LocalServerChatHandler({
      graphService: chatGraphService,
      tuiSessions,
      inflightRequests,
    });
    const studioHandler = new LocalServerStudioHandler({
      reviewRouter: studioReviewRouter,
      inflightRequests,
      getStudioDueRunScheduler: () => depsWithRuntime.studioDueRunScheduler,
    });
    const authToken = ensureLocalServerAuthToken();
    const server = createServer((req, res) => {
      const handled = handleLocalHttpRequest(req, res, depsWithRuntime, {
        authToken,
        loadHistory: () => tuiSessions.loadHistory(depsWithRuntime),
        loadSnapshot: async () => {
          const messages = await tuiSessions.loadHistory(depsWithRuntime);
          const pendingReview = await chatHandler.readPendingReviewSnapshot(depsWithRuntime);
          const sessionId = tuiSessions.getActiveSessionId(depsWithRuntime.actorId);
          return buildLocalServerTuiSnapshot({
            sessionId,
            kind: 'chat',
            messages,
            deps: depsWithRuntime,
            pendingReview,
          });
        },
        listSessions: () => tuiSessions.listSessions(depsWithRuntime),
        resumeSession: async (sessionId) => {
          const result = await tuiSessions.resumeSession(depsWithRuntime, sessionId);
          const pendingReview = await chatHandler.readPendingReviewSnapshot(depsWithRuntime);
          return {
            session: {
              ...result.session,
              kind: 'chat',
            },
            messages: result.messages,
            snapshot: buildLocalServerTuiSnapshot({
              sessionId: result.session.id,
              kind: 'chat',
              messages: result.messages,
              deps: depsWithRuntime,
              pendingReview,
            }),
          };
        },
      });
      if (handled) {
        return;
      }
      res.writeHead(404);
      res.end();
    });

    attachLocalServerWebSocketTransport(server, {
      onChatRequest: (ws, msg) => chatHandler.handleChatRequest(ws, msg, depsWithRuntime),
      onStudioRequest: (ws, msg) => studioHandler.handleStudioRequest(ws, msg, depsWithRuntime),
      onHumanReviewResponse: (ws, msg) => {
        if (studioHandler.routeHumanReviewResponse(ws, msg)) {
          return;
        }
        return chatHandler.handleHumanReviewResponse(ws, msg, depsWithRuntime);
      },
      onInterruptRequest: async (ws, msg) => {
        if (await chatHandler.handleInterruptRequest(ws, msg, depsWithRuntime)) {
          return;
        }
        const inflight = inflightRequests.interrupt(ws, { requestId: msg.requestId });
        if (inflight) {
          console.log(`[local-server] interrupt requestId=${inflight.requestId}`);
        }
      },
      onNewSession: () => {
        tuiSessions.createNewSession(depsWithRuntime.actorId);
        console.log(`[local-server] new session created for pet ${depsWithRuntime.actorId}`);
      },
      onRuntimeConfigUpdate: (_ws, msg) => {
        const nextLlmConfig = {
          ...depsWithRuntime.llmConfig,
          globalReviewPolicyMode: msg.globalReviewPolicyMode,
        };
        deps.llmConfig = nextLlmConfig;
        depsWithRuntime.llmConfig = nextLlmConfig;
        console.log(`[local-server] global review policy set to ${msg.globalReviewPolicyMode}`);
      },
      onClose: (ws) => {
        inflightRequests.abortAndClear(ws);
        studioHandler.rejectDisconnected(ws);
      },
    }, {
      authToken,
      port,
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`[local-server] listening on ws://127.0.0.1:${port}`);
      console.log('[local-server] local HTTP/WS auth enabled');
      resolve();
    });

    server.on('error', reject);
  });
}
