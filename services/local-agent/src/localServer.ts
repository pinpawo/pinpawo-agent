/**
 * Local WebSocket server for TUI ↔ run process communication.
 *
 * Runs inside the `run` process. TUI connects via ws://127.0.0.1:<port>.
 * Protocol matches the App WS relay format so both paths share the same
 * message types.
 */
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { HumanMessage } from '@langchain/core/messages';
import { loadAgentContext } from './contextLoader';
import { LocalAgentGraphService } from './agentGraphService';
import { authorizeShellPattern } from './sessionAuthorizations';
import { readShellReviewCommand } from './chatInterrupts';
import {
  sendLocalAgentEvent,
  sendLocalAgentMessage,
  type ChatRequestMessage,
  type HumanReviewResponseMessage,
  type StudioRequestMessage,
} from './localAgentProtocol';
import { recordAgentRunActivity } from './operationActivityState';
import {
  type StreamToolsPayload,
} from './agentStreamEvents';
import { runChatSession } from './chatSessionAdapter';
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

function isToolProtocolHistoryError(value: unknown): boolean {
  const text = value instanceof Error
    ? `${value.name}\n${value.message}\n${value.stack ?? ''}`
    : String(value ?? '');
  return text.includes('INVALID_TOOL_RESULTS')
    || text.includes("An assistant message with 'tool_calls' must be followed by tool messages")
    || text.includes('insufficient tool messages following tool_calls message');
}

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

async function handleChatRequest(ws: WebSocket, msg: ChatRequestMessage, deps: LocalServerDeps) {
  const { requestId, message } = msg;

  const threadId = tuiSessions.getChatThreadId(deps.actorId);

  console.log(`[local-server] chat_request requestId=${requestId} message="${message.slice(0, 80)}"`);
  recordAgentRunActivity('thinking', requestId);

  const previousInflight = inflightRequests.get(ws);
  const inflight = inflightRequests.start(ws, requestId, {
    interruptPrevious: true,
    notifyPrevious: true,
  });
  if (previousInflight) {
    console.warn(`[local-server] abort previous inflight requestId=${previousInflight.requestId} before starting requestId=${requestId}`);
  }
  const { controller } = inflight;
  const isCurrent = () => inflightRequests.isCurrentActive(ws, inflight);
  const finishInterrupted = () => {
    if (!controller.signal.aborted) {
      return;
    }
    inflightRequests.sendInterrupted(ws, inflight);
    inflightRequests.clear(ws, inflight);
  };

  try {
    const ctx = await loadAgentContext(deps.actorId);
    if (!isCurrent()) {
      finishInterrupted();
      return;
    }

    const setup = tuiSessions.buildChatSetup(deps, ctx);
    setup.input.messages = [
      ...setup.input.messages.slice(0, -1),
      new HumanMessage(message),
    ];
    setup.input.signal = controller.signal;
    const result = await runChatSession({
      request: msg,
      setup,
      graphService: chatGraphService,
      isCurrent,
      finishInterrupted,
      emitEvent: (event) => {
        sendLocalAgentEvent(ws, event);
      },
      emitToolEvent: (event) => {
        sendStreamToolOperationEvent(ws, inflight, event);
      },
      onPendingInterrupt: (pendingInterrupt) => {
        const pendingShellCommand = readShellReviewCommand(pendingInterrupt);
        if (!pendingShellCommand || !message.trim().startsWith('/allow')) {
          return;
        }
        const requestedPattern = message.trim().slice('/allow'.length).trim();
        const authorizedPattern = authorizeShellPattern(
          threadId,
          requestedPattern || pendingShellCommand,
        );
        if (authorizedPattern) {
          sendLocalAgentEvent(ws, {
            type: 'system.notice',
            requestId,
            message: `已授权本次会话中的 shell 模式：${authorizedPattern}`,
          });
        }
      },
    });
    if (result.status === 'waiting_human') {
      inflightRequests.finish(ws, inflight, 'interrupted');
      await tuiSessions.refreshActiveSessionSummary(deps);
      console.log(`[local-server] human_review.requested requestId=${requestId}`);
      inflightRequests.clear(ws, inflight);
      return;
    }
    if (result.status === 'interrupted') {
      return;
    }
    inflightRequests.finish(ws, inflight, 'completed');
    inflightRequests.clear(ws, inflight);
    await tuiSessions.refreshActiveSessionSummary(deps);

    console.log(`[local-server] message.completed sent requestId=${requestId} reply="${result.reply.slice(0, 100)}"`);
  } catch (err) {
    const isStillCurrent = inflightRequests.isCurrent(ws, inflight);
    const aborted = controller.signal.aborted
      || (err instanceof Error && err.name === 'AbortError');
    if (aborted) {
      console.warn(`[local-server] chat interrupted requestId=${requestId}`);
      inflightRequests.sendInterrupted(ws, inflight);
      recordAgentRunActivity('interrupted', requestId, 2_500);
      inflightRequests.clear(ws, inflight);
      return;
    }
    inflightRequests.finish(ws, inflight, 'failed', err);
    inflightRequests.clear(ws, inflight);
    recordAgentRunActivity('error', requestId, 5_000);
    console.error('[local-server] chat error:', err instanceof Error ? (err.stack ?? err.message) : err);
    const recoveredFromToolProtocolError = isToolProtocolHistoryError(err);
    if (recoveredFromToolProtocolError) {
      try {
        await tuiSessions.resetSession(deps.actorId, { deletePrevious: true });
        console.warn(`[local-server] reset TUI chat session after tool protocol error requestId=${requestId}`);
      } catch (resetError) {
        console.warn(
          '[local-server] failed to reset TUI chat session after tool protocol error:',
          resetError instanceof Error ? resetError.message : resetError,
        );
      }
    }
    if (isStillCurrent && ws.readyState === WebSocket.OPEN) {
      const message = err instanceof Error ? err.message : 'internal error';
      sendLocalAgentEvent(ws, {
        type: 'error',
        requestId,
        message: recoveredFromToolProtocolError
          ? `${message}\n\n已重置本地 TUI 会话，下一条消息会从新的后端会话继续。`
          : message,
      });
    }
  }
}

async function handleHumanReviewResponse(ws: WebSocket, msg: HumanReviewResponseMessage, deps: LocalServerDeps) {
  if (studioReviewRouter.routeResponse(ws, msg)) {
    return;
  }
  await handleChatRequest(ws, {
    type: 'chat_request',
    requestId: msg.requestId,
    message: msg.message,
    ...(msg.resume !== undefined ? { resume: msg.resume } : {}),
  }, deps);
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
      onChatRequest: (ws, msg) => handleChatRequest(ws, msg, deps),
      onStudioRequest: (ws, msg) => handleStudioRequest(ws, msg, deps),
      onHumanReviewResponse: (ws, msg) => handleHumanReviewResponse(ws, msg, deps),
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
