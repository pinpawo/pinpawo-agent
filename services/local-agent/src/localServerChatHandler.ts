import { WebSocket } from 'ws';
import { HumanMessage } from '@langchain/core/messages';
import { loadAgentContext } from './contextLoader';
import {
  sendLocalAgentEvent,
  type ChatRequestMessage,
  type HumanReviewResponseMessage,
} from './localAgentProtocol';
import { recordAgentRunActivity } from './operationActivityState';
import {
  type StreamToolsPayload,
} from './agentStreamEvents';
import { runChatSession } from './chatSessionAdapter';
import {
  configureInflightOperationRegistry,
  type InflightOperationRun,
} from './inflightOperationRun';
import { InflightRequestController } from './inflightRequestController';
import { emitLocalServerToolOperationEvent } from './localServerOperationEvents';
import { LocalAgentGraphService } from './agentGraphService';
import { LocalServerTuiSessionService } from './localServerTuiSessions';
import type { LocalServerDeps } from './localServerTypes';
import { createOperationRegistryForAgentSetup } from './runtimeOperationRegistry';
import type { LocalAgentEvent } from './events/localAgentEvent';

type InflightRequest = InflightOperationRun;

type PendingReviewRoute = {
  reviewId: string;
  sessionId?: string;
};

export function isToolProtocolHistoryError(value: unknown): boolean {
  const text = value instanceof Error
    ? `${value.name}\n${value.message}\n${value.stack ?? ''}`
    : String(value ?? '');
  return text.includes('INVALID_TOOL_RESULTS')
    || text.includes("An assistant message with 'tool_calls' must be followed by tool messages")
    || text.includes('insufficient tool messages following tool_calls message');
}

export class LocalServerChatHandler {
  private readonly graphService: LocalAgentGraphService;
  private readonly tuiSessions: LocalServerTuiSessionService;
  private readonly inflightRequests: InflightRequestController<WebSocket>;
  private readonly pendingReviewRoutes = new Map<string, PendingReviewRoute>();

  constructor(options: {
    graphService: LocalAgentGraphService;
    tuiSessions: LocalServerTuiSessionService;
    inflightRequests: InflightRequestController<WebSocket>;
  }) {
    this.graphService = options.graphService;
    this.tuiSessions = options.tuiSessions;
    this.inflightRequests = options.inflightRequests;
  }

  private recordPendingReviewRoute(
    event: LocalAgentEvent,
    deps: LocalServerDeps,
  ) {
    if (event.type !== 'human_review.requested' || !event.review?.id) {
      return;
    }
    const sessionId = this.tuiSessions.getActiveSessionId(deps.actorId);
    this.pendingReviewRoutes.set(event.requestId, {
      reviewId: event.review.id,
      ...(sessionId ? { sessionId } : {}),
    });
  }

  async handleChatRequest(
    ws: WebSocket,
    msg: ChatRequestMessage,
    deps: LocalServerDeps,
  ) {
    const { requestId, message } = msg;

    console.log(`[local-server] chat_request requestId=${requestId} message="${message.slice(0, 80)}"`);
    recordAgentRunActivity('thinking', requestId);

    const previousInflight = this.inflightRequests.get(ws);
    const inflight = this.inflightRequests.start(ws, requestId, {
      interruptPrevious: true,
      notifyPrevious: true,
    });
    if (previousInflight) {
      console.warn(`[local-server] abort previous inflight requestId=${previousInflight.requestId} before starting requestId=${requestId}`);
    }
    const { controller } = inflight;
    const isCurrent = () => this.inflightRequests.isCurrentActive(ws, inflight);
    const finishInterrupted = () => {
      if (!controller.signal.aborted) {
        return;
      }
      this.inflightRequests.sendInterrupted(ws, inflight);
      this.inflightRequests.clear(ws, inflight);
    };

    try {
      const ctx = await loadAgentContext(deps.actorId);
      if (!isCurrent()) {
        finishInterrupted();
        return;
      }

      const setup = this.tuiSessions.buildChatSetup(deps, ctx);
      configureInflightOperationRegistry(
        inflight,
        createOperationRegistryForAgentSetup(setup),
      );
      setup.input.messages = [
        ...setup.input.messages.slice(0, -1),
        new HumanMessage(message),
      ];
      setup.input.signal = controller.signal;
      const result = await runChatSession({
        request: msg,
        setup,
        graphService: this.graphService,
        isCurrent,
        finishInterrupted,
        emitEvent: (event) => {
          this.recordPendingReviewRoute(event, deps);
          sendLocalAgentEvent(ws, event);
        },
        emitToolEvent: (event) => {
          this.sendStreamToolOperationEvent(ws, inflight, event);
        },
      });
      if (result.status === 'waiting_human') {
        this.inflightRequests.finish(ws, inflight, 'interrupted');
        await this.tuiSessions.refreshActiveSessionSummary(deps);
        console.log(`[local-server] human_review.requested requestId=${requestId}`);
        this.inflightRequests.clear(ws, inflight);
        return;
      }
      if (result.status === 'interrupted') {
        return;
      }
      this.inflightRequests.finish(ws, inflight, 'completed');
      this.inflightRequests.clear(ws, inflight);
      await this.tuiSessions.refreshActiveSessionSummary(deps);

      console.log(`[local-server] message.completed sent requestId=${requestId} reply="${result.reply.slice(0, 100)}"`);
    } catch (err) {
      const isStillCurrent = this.inflightRequests.isCurrent(ws, inflight);
      const aborted = controller.signal.aborted
        || (err instanceof Error && err.name === 'AbortError');
      if (aborted) {
        console.warn(`[local-server] chat interrupted requestId=${requestId}`);
        this.inflightRequests.sendInterrupted(ws, inflight);
        recordAgentRunActivity('interrupted', requestId, 2_500);
        this.inflightRequests.clear(ws, inflight);
        return;
      }
      this.inflightRequests.finish(ws, inflight, 'failed', err);
      this.inflightRequests.clear(ws, inflight);
      recordAgentRunActivity('error', requestId, 5_000);
      console.error('[local-server] chat error:', err instanceof Error ? (err.stack ?? err.message) : err);
      const recoveredFromToolProtocolError = isToolProtocolHistoryError(err);
      if (recoveredFromToolProtocolError) {
        try {
          await this.tuiSessions.resetSession(deps.actorId, { deletePrevious: true });
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

  async handleHumanReviewResponse(
    ws: WebSocket,
    msg: HumanReviewResponseMessage,
    deps: LocalServerDeps,
  ) {
    const route = this.pendingReviewRoutes.get(msg.requestId);
    if (!route) {
      console.warn(
        `[local-server] human_review_response rejected: no pending review route for requestId=${msg.requestId}`,
      );
      sendLocalAgentEvent(ws, {
        type: 'error',
        requestId: msg.requestId,
        message: '这个 review 已关闭或不存在，请等待当前确认面板刷新后再应答。',
      });
      return;
    }
    if (msg.reviewId !== route.reviewId) {
      console.warn(
        `[local-server] human_review_response rejected: reviewId=${msg.reviewId} `
        + `does not match pending review=${route.reviewId}`,
      );
      sendLocalAgentEvent(ws, {
        type: 'error',
        requestId: msg.requestId,
        message: '这个 review 已经过期，请等待当前确认面板刷新后再应答。',
      });
      return;
    }

    const activeSessionId = this.tuiSessions.getActiveSessionId(deps.actorId);
    if (route.sessionId && activeSessionId && route.sessionId !== activeSessionId) {
      console.warn(
        `[local-server] human_review_response rejected: route sessionId=${route.sessionId} `
        + `does not match active session=${activeSessionId}`,
      );
      sendLocalAgentEvent(ws, {
        type: 'error',
        requestId: msg.requestId,
        message: '请回到发起该 review 的会话再应答。',
      });
      return;
    }

    this.pendingReviewRoutes.delete(msg.requestId);

    await this.handleChatRequest(ws, {
      type: 'chat_request',
      requestId: msg.requestId,
      message: '',
      resume: {
        reviewId: msg.reviewId,
        selectedOptionId: msg.selectedOptionId,
        ...(msg.input ? { input: msg.input } : {}),
      },
    }, deps);
  }

  private sendStreamToolOperationEvent(
    ws: WebSocket,
    inflight: InflightRequest,
    payload: StreamToolsPayload,
  ) {
    emitLocalServerToolOperationEvent({
      run: inflight,
      payload,
      emit: (event) => sendLocalAgentEvent(ws, event),
    });
  }
}
