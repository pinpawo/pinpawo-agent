/**
 * Local WebSocket server for TUI ↔ run process communication.
 *
 * Runs inside the `run` process. TUI connects via ws://127.0.0.1:<port>.
 * Protocol matches the App WS relay format so both paths share the same
 * message types.
 */
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { FileStudioDueRunStore } from '@pinpawo/pet-agent';
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
import { buildLocalAgentSessionSnapshot } from './localAgentSessionSnapshot';
import { createLocalServerRuntimeDepsStore, type LocalServerDeps } from './localServerTypes';

export type { LocalServerDeps };

const INTERRUPT_FORCE_REPLY_MS = 1800;

export function startLocalServer(port: number, deps: LocalServerDeps): Promise<void> {
  return new Promise((resolve, reject) => {
    const runtimeDeps = createLocalServerRuntimeDepsStore(deps);
    const initialDeps = runtimeDeps.get();
    const effectiveRuntimeConfig = initialDeps.runtimeConfig;
    const chatGraphService = new LocalAgentGraphService();
    const tuiSessions = new LocalServerTuiSessionService({
      graphService: chatGraphService,
      runtimeConfig: effectiveRuntimeConfig,
    });
    const studioReviewRouter = new LocalServerStudioReviewRouter<WebSocket>();
    const studioDueRunScheduler = initialDeps.studioDueRunScheduler
      ?? new LocalStudioDueRunScheduler({
        store: new FileStudioDueRunStore({
          filePath: effectiveRuntimeConfig.studioDueRunsPath,
        }),
        filterWorkdir: effectiveRuntimeConfig.workdir,
      });
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
      ...(studioDueRunScheduler ? { studioDueRunScheduler } : {}),
    });
    const authToken = ensureLocalServerAuthToken();
    const server = createServer((req, res) => {
      const requestDeps = runtimeDeps.get();
      const handled = handleLocalHttpRequest(req, res, requestDeps, {
        authToken,
        loadHistory: () => tuiSessions.loadHistory(requestDeps),
        loadSnapshot: async () => {
          const messages = await tuiSessions.loadHistory(requestDeps);
          const pendingReview = await chatHandler.readReviewActionSnapshot(requestDeps);
          const sessionId = tuiSessions.getActiveSessionId(requestDeps.actorId);
          return buildLocalAgentSessionSnapshot({
            sessionId,
            kind: 'chat',
            messages,
            deps: requestDeps,
            pendingReview,
          });
        },
        listSessions: () => tuiSessions.listSessions(requestDeps),
        resumeSession: async (sessionId) => {
          const result = await tuiSessions.resumeSession(requestDeps, sessionId);
          const pendingReview = await chatHandler.readReviewActionSnapshot(requestDeps);
          return {
            session: {
              ...result.session,
              kind: 'chat',
            },
            messages: result.messages,
            snapshot: buildLocalAgentSessionSnapshot({
              sessionId: result.session.id,
              kind: 'chat',
              messages: result.messages,
              deps: requestDeps,
              pendingReview,
            }),
          };
        },
        updateCapabilities: (patch) => runtimeDeps.updateCapabilities(patch),
      });
      if (handled) {
        return;
      }
      res.writeHead(404);
      res.end();
    });

    attachLocalServerWebSocketTransport(server, {
      onChatRequest: (ws, msg) => chatHandler.handleChatRequest(ws, msg, runtimeDeps.get()),
      onStudioRequest: (ws, msg) => studioHandler.handleStudioRequest(ws, msg, runtimeDeps.get()),
      onHumanReviewResponse: (ws, msg) => {
        if (studioHandler.routeHumanReviewResponse(ws, msg)) {
          return;
        }
        return chatHandler.handleHumanReviewResponse(ws, msg, runtimeDeps.get());
      },
      onReviewCancel: (ws, msg) => chatHandler.handleReviewCancel(ws, msg, runtimeDeps.get()),
      onRunInterrupt: (ws, msg) => {
        const inflight = inflightRequests.interrupt(ws, { requestId: msg.requestId });
        if (inflight) {
          console.log(`[local-server] interrupt requestId=${inflight.requestId}`);
        }
      },
      onNewSession: () => {
        const actorId = runtimeDeps.get().actorId;
        tuiSessions.createNewSession(actorId);
        console.log(`[local-server] new session created for pet ${actorId}`);
      },
      onRuntimeConfigUpdate: (_ws, msg) => {
        runtimeDeps.updateLlmConfig({
          globalReviewPolicyMode: msg.globalReviewPolicyMode,
        });
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
