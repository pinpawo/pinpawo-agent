/**
 * Local WebSocket server for TUI ↔ run process communication.
 *
 * Runs inside the `run` process. TUI connects via ws://127.0.0.1:<port>.
 * Protocol matches the App WS relay format so both paths share the same
 * message types.
 */
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { LocalAgentGraphService } from './agentGraphService';
import {
  sendLocalAgentEvent,
  sendLocalAgentMessage,
} from './localAgentProtocol';
import { InflightRequestController } from './inflightRequestController';
import { LocalServerStudioReviewRouter } from './localServerStudioReviews';
import { LocalServerTuiSessionService } from './localServerTuiSessions';
import { handleLocalHttpRequest } from './localHttpHandlers';
import { attachLocalServerWebSocketTransport } from './localServerWsTransport';
import { ensureLocalServerAuthToken } from './localServerAuth';
import { LocalServerChatHandler } from './localServerChatHandler';
import { LocalServerStudioHandler } from './localServerStudioHandler';
import type { LocalServerDeps } from './localServerTypes';

export type { LocalServerDeps };

const INTERRUPT_FORCE_REPLY_MS = 1800;

export function startLocalServer(port: number, deps: LocalServerDeps): Promise<void> {
  return new Promise((resolve, reject) => {
    const chatGraphService = new LocalAgentGraphService();
    const tuiSessions = new LocalServerTuiSessionService({
      graphService: chatGraphService,
      ...(deps.runtimeConfig ? {
        checkpointPath: deps.runtimeConfig.tuiCheckpointPath,
        sessionStatePath: deps.runtimeConfig.tuiSessionPath,
      } : {}),
    });
    const studioReviewRouter = new LocalServerStudioReviewRouter<WebSocket>();
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
    });
    const authToken = ensureLocalServerAuthToken();
    const server = createServer((req, res) => {
      const handled = handleLocalHttpRequest(req, res, deps, {
        authToken,
        loadHistory: () => tuiSessions.loadHistory(deps),
        listSessions: () => tuiSessions.listSessions(deps),
        resumeSession: (sessionId) => tuiSessions.resumeSession(deps, sessionId),
      });
      if (handled) {
        return;
      }
      res.writeHead(404);
      res.end();
    });

    attachLocalServerWebSocketTransport(server, {
      onChatRequest: (ws, msg) => chatHandler.handleChatRequest(ws, msg, deps),
      onStudioRequest: (ws, msg) => studioHandler.handleStudioRequest(ws, msg, deps),
      onHumanReviewResponse: (ws, msg) => {
        if (studioHandler.routeHumanReviewResponse(ws, msg)) {
          return;
        }
        return chatHandler.handleHumanReviewResponse(ws, msg, deps);
      },
      onInterruptRequest: async (ws, msg) => {
        if (await chatHandler.handleInterruptRequest(ws, msg, deps)) {
          return;
        }
        const inflight = inflightRequests.interrupt(ws, { requestId: msg.requestId });
        if (inflight) {
          console.log(`[local-server] interrupt requestId=${inflight.requestId}`);
        }
      },
      onNewSession: () => {
        tuiSessions.createNewSession(deps.actorId);
        console.log(`[local-server] new session created for pet ${deps.actorId}`);
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
