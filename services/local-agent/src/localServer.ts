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
  type StudioRequestMessage,
} from './localAgentProtocol';
import {
  type StreamToolsPayload,
} from './agentStreamEvents';
import {
  type InflightOperationRun,
} from './inflightOperationRun';
import { InflightRequestController } from './inflightRequestController';
import { emitLocalServerToolOperationEvent } from './localServerOperationEvents';
import {
  buildStudioForTurn,
  StudioNotConfiguredError,
} from './studio/studioRuntime';
import { LocalServerStudioReviewRouter } from './localServerStudioReviews';
import { LocalServerTuiSessionService } from './localServerTuiSessions';
import { handleLocalHttpRequest } from './localHttpHandlers';
import { attachLocalServerWebSocketTransport } from './localServerWsTransport';
import { LocalServerChatHandler } from './localServerChatHandler';
import type { AgentStats, LocalServerDeps } from './localServerTypes';

export type { AgentStats, LocalServerDeps };

const chatGraphService = new LocalAgentGraphService();
const tuiSessions = new LocalServerTuiSessionService({ graphService: chatGraphService });

const studioReviewRouter = new LocalServerStudioReviewRouter<WebSocket>();
const INTERRUPT_FORCE_REPLY_MS = 1800;

type InflightRequest = InflightOperationRun;

const inflightRequests = new InflightRequestController<WebSocket>({
  forceInterruptMs: INTERRUPT_FORCE_REPLY_MS,
  emitOperation: (ws, event) => sendLocalAgentEvent(ws, event),
  sendControl: (ws, message) => sendLocalAgentMessage(ws, message),
  logPrefix: 'local-server',
});

const chatHandler = new LocalServerChatHandler({
  graphService: chatGraphService,
  tuiSessions,
  inflightRequests,
});

function sendStreamToolOperationEvent(ws: WebSocket, inflight: InflightRequest, payload: StreamToolsPayload) {
  emitLocalServerToolOperationEvent({
    run: inflight,
    payload,
    emit: (event) => sendLocalAgentEvent(ws, event),
  });
}

async function handleStudioRequest(
  ws: WebSocket,
  msg: StudioRequestMessage,
  deps: LocalServerDeps,
) {
  const { requestId, userRequest } = msg;
  const conversationId = msg.conversationId ?? requestId;

  console.log(`[local-server] studio_request requestId=${requestId} userRequest="${userRequest.slice(0, 80)}"`);

  // 取消已有 inflight(避免跟 chat 重叠)
  const inflight = inflightRequests.start(ws, requestId, {
    interruptPrevious: true,
    notifyPrevious: true,
  });
  const { controller } = inflight;

  // 重置 review slot(防止上一 turn 残留)
  const slot = studioReviewRouter.getOrCreateSlot(ws);
  if (slot.current) {
    studioReviewRouter.rejectPending(ws, new Error('superseded by new studio_request'));
  }

  const send = (envelope: unknown) => {
    if (!envelope || typeof envelope !== 'object') return;
    sendLocalAgentMessage(ws, envelope as Parameters<typeof sendLocalAgentMessage>[1]);
  };

  try {
    const { orchestrator } = await buildStudioForTurn({
      llmConfig: deps.llmConfig,
      capabilities: [
        ...(deps.localCapabilities ?? []),
        ...(deps.userCapabilities ?? []).map((u) => u.capability),
      ],
      tools: [...deps.pluginTools, ...deps.localTools],
      ownerUserId: null, // Phase 2 MVP: 纯本地,无服务端 owner 绑定
      bridge: { send, requestId, slot },
    });

    const result = await orchestrator.invoke({
      userRequest,
      conversationId,
      turnId: requestId,
      signal: controller.signal,
      onTurnEvent: (event) => {
        sendLocalAgentEvent(ws, {
          type: 'studio.progress',
          requestId,
          event,
        });
      },
      onToolEvent: (event) => {
        sendStreamToolOperationEvent(ws, inflight, event as StreamToolsPayload);
      },
    });

    if (controller.signal.aborted) {
      inflightRequests.finish(ws, inflight, 'interrupted');
      send({ type: 'studio_error', requestId, message: 'aborted by client' });
      return;
    }

    inflightRequests.finish(ws, inflight, 'completed');
    if (result.outcome.outcome === 'done') {
      send({
        type: 'studio_response',
        requestId,
        outcome: 'done',
        reply: result.outcome.reply,
        finalDispatchId: result.outcome.finalDispatchId,
      });
    } else {
      send({
        type: 'studio_response',
        requestId,
        outcome: 'stopped',
        reply: result.outcome.reply,
        reason: result.outcome.reason,
      });
    }
  } catch (err) {
    inflightRequests.finish(ws, inflight, 'failed', err);
    if (err instanceof StudioNotConfiguredError) {
      send({
        type: 'studio_error',
        requestId,
        message: `Studio 未配置:${err.message}`,
      });
    } else {
      console.error(
        '[local-server] handleStudioRequest error:',
        err instanceof Error ? err.message : err,
      );
      send({
        type: 'studio_error',
        requestId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    if (slot.current) {
      studioReviewRouter.rejectPending(ws, new Error('studio turn ended with unresolved review'));
    }
    inflightRequests.clear(ws, inflight);
  }
}

export function startLocalServer(port: number, deps: LocalServerDeps): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const handled = handleLocalHttpRequest(req, res, deps, {
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
      onStudioRequest: (ws, msg) => handleStudioRequest(ws, msg, deps),
      onHumanReviewResponse: (ws, msg) => {
        if (studioReviewRouter.routeResponse(ws, msg)) {
          return;
        }
        return chatHandler.handleHumanReviewResponse(ws, msg, deps);
      },
      onInterruptRequest: (ws, msg) => {
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
        studioReviewRouter.rejectAndDelete(ws, new Error('ws disconnected'));
      },
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`[local-server] listening on ws://127.0.0.1:${port}`);
      resolve();
    });

    server.on('error', reject);
  });
}
