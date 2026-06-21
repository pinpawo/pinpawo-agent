import { WebSocket } from 'ws';
import type { ReviewSpec } from '@pinpawo/pet-agent';
import { loadAgentContext } from './contextLoader';
import {
  sendLocalAgentEvent,
  type ChatRequestMessage,
  type HumanReviewResponseMessage,
  type InterruptRequestMessage,
} from './localAgentProtocol';
import { recordAgentRunActivity } from './operationActivityState';
import {
  type StreamToolsPayload,
} from './agentStreamEvents';
import { runChatSession, type ChatSessionRequest } from './chatSessionAdapter';
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

type LocalServerRunRequest = ChatSessionRequest;

type LocalServerRunSource =
  | { type: 'chat_request' }
  | { type: 'human_review_response'; reviewId: string; selectedOptionId: string }
  | { type: 'interrupt_request'; reviewId: string; selectedOptionId: string };

type PendingReviewRoute = {
  reviewId: string;
  rejectOptionId?: string;
  sessionId?: string;
  review: ReviewSpec;
  actor?: Extract<LocalAgentEvent, { type: 'human_review.requested' }>['actor'];
};

export type PendingReviewSnapshot = {
  requestId: string;
  reviewId: string;
  sessionId?: string;
  review: ReviewSpec;
  actor?: Extract<LocalAgentEvent, { type: 'human_review.requested' }>['actor'];
};

const MAX_CONSUMED_PENDING_REVIEW_REQUEST_IDS = 1000;

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
  private readonly consumedPendingReviewRequestIds = new Set<string>();
  private readonly activePendingReviewRequestIds = new Set<string>();

  constructor(options: {
    graphService: LocalAgentGraphService;
    tuiSessions: LocalServerTuiSessionService;
    inflightRequests: InflightRequestController<WebSocket>;
  }) {
    this.graphService = options.graphService;
    this.tuiSessions = options.tuiSessions;
    this.inflightRequests = options.inflightRequests;
  }

  private buildPendingReviewRoute(params: {
    review: ReviewSpec;
    sessionId?: string;
    actor?: PendingReviewRoute['actor'];
  }): PendingReviewRoute {
    const rejectOption = params.review.options.find((option) => option.decision.type === 'reject');
    return {
      reviewId: params.review.id,
      ...(rejectOption ? { rejectOptionId: rejectOption.id } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      review: params.review,
      ...(params.actor ? { actor: params.actor } : {}),
    };
  }

  private recordPendingReviewRoute(
    event: LocalAgentEvent,
    deps: LocalServerDeps,
  ) {
    if (event.type !== 'human_review.requested' || !event.review?.id) {
      return;
    }
    this.consumedPendingReviewRequestIds.delete(event.requestId);
    this.activePendingReviewRequestIds.delete(event.requestId);
    const sessionId = this.tuiSessions.getActiveSessionId(deps.actorId);
    this.pendingReviewRoutes.set(event.requestId, this.buildPendingReviewRoute({
      review: event.review,
      ...(sessionId ? { sessionId } : {}),
      ...(event.actor ? { actor: event.actor } : {}),
    }));
  }

  private async recoverPendingReviewRoute(
    requestId: string,
    deps: LocalServerDeps,
  ) {
    try {
      const pending = await this.tuiSessions.readActivePendingReview(deps);
      if (!pending) {
        return null;
      }
      const route = this.buildPendingReviewRoute({
        review: pending.review,
        sessionId: pending.sessionId,
      });
      this.pendingReviewRoutes.set(requestId, route);
      return route;
    } catch (err) {
      console.warn(
        '[local-server] failed to recover pending human_review from checkpoint:',
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  private async readPendingReviewRoute(
    requestId: string,
    deps: LocalServerDeps,
  ) {
    const route = this.pendingReviewRoutes.get(requestId);
    if (route) {
      return route;
    }
    if (this.consumedPendingReviewRequestIds.has(requestId)) {
      return null;
    }
    return this.recoverPendingReviewRoute(requestId, deps);
  }

  private claimPendingReviewRequest(requestId: string) {
    if (
      this.consumedPendingReviewRequestIds.has(requestId)
      || this.activePendingReviewRequestIds.has(requestId)
    ) {
      return false;
    }
    this.activePendingReviewRequestIds.add(requestId);
    return true;
  }

  private releasePendingReviewRequest(requestId: string) {
    this.activePendingReviewRequestIds.delete(requestId);
  }

  private markPendingReviewConsumed(requestId: string) {
    this.pendingReviewRoutes.delete(requestId);
    this.activePendingReviewRequestIds.delete(requestId);
    this.consumedPendingReviewRequestIds.add(requestId);
    while (this.consumedPendingReviewRequestIds.size > MAX_CONSUMED_PENDING_REVIEW_REQUEST_IDS) {
      const oldest = this.consumedPendingReviewRequestIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.consumedPendingReviewRequestIds.delete(oldest);
    }
  }

  async readPendingReviewSnapshot(deps: LocalServerDeps): Promise<PendingReviewSnapshot | null> {
    const activeSessionId = this.tuiSessions.getActiveSessionId(deps.actorId);
    for (const [requestId, route] of this.pendingReviewRoutes) {
      if (route.sessionId && activeSessionId && route.sessionId !== activeSessionId) {
        continue;
      }
      return {
        requestId,
        reviewId: route.reviewId,
        ...(route.sessionId ? { sessionId: route.sessionId } : {}),
        review: route.review,
        ...(route.actor ? { actor: route.actor } : {}),
      };
    }

    const pending = await this.tuiSessions.readActivePendingReview(deps);
    if (!pending) {
      return null;
    }
    const requestId = `snapshot:${pending.sessionId}:${pending.review.id}`;
    const route = this.buildPendingReviewRoute({
      review: pending.review,
      sessionId: pending.sessionId,
    });
    this.pendingReviewRoutes.set(requestId, route);
    return {
      requestId,
      reviewId: route.reviewId,
      sessionId: pending.sessionId,
      review: route.review,
    };
  }

  private sendClosedReviewError(ws: WebSocket, requestId: string) {
    sendLocalAgentEvent(ws, {
      type: 'error',
      requestId,
      message: '这个 review 已关闭或不存在，请等待当前确认面板刷新后再应答。',
    });
  }

  async handleChatRequest(
    ws: WebSocket,
    msg: ChatRequestMessage,
    deps: LocalServerDeps,
  ) {
    return this.runChatRequest(ws, {
      kind: 'user_message',
      requestId: msg.requestId,
      message: msg.message,
    }, deps, { type: 'chat_request' });
  }

  private async runChatRequest(
    ws: WebSocket,
    request: LocalServerRunRequest,
    deps: LocalServerDeps,
    source: LocalServerRunSource,
  ) {
    const { requestId } = request;
    const message = request.kind === 'user_message' ? request.message : '';

    if (source.type === 'chat_request') {
      console.log(`[local-server] chat_request requestId=${requestId} message="${message.slice(0, 80)}"`);
    } else if (source.type === 'human_review_response') {
      console.log(
        `[local-server] human_review_response requestId=${requestId} `
        + `reviewId=${source.reviewId} option=${source.selectedOptionId}`,
      );
    } else {
      console.log(
        `[local-server] interrupt_request resume human_review requestId=${requestId} `
        + `reviewId=${source.reviewId} option=${source.selectedOptionId}`,
      );
    }
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
      setup.input.signal = controller.signal;
      const result = await runChatSession({
        request,
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
          await this.tuiSessions.resetSession(deps.actorId, {
            deletePrevious: true,
          });
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
    if (!this.claimPendingReviewRequest(msg.requestId)) {
      console.warn(
        `[local-server] human_review_response rejected: pending review request already consumed or active requestId=${msg.requestId}`,
      );
      this.sendClosedReviewError(ws, msg.requestId);
      return;
    }

    const route = await this.readPendingReviewRoute(msg.requestId, deps);
    if (!route) {
      this.releasePendingReviewRequest(msg.requestId);
      console.warn(
        `[local-server] human_review_response rejected: no pending review route for requestId=${msg.requestId}`,
      );
      this.sendClosedReviewError(ws, msg.requestId);
      return;
    }
    if (msg.reviewId !== route.reviewId) {
      this.releasePendingReviewRequest(msg.requestId);
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
      this.releasePendingReviewRequest(msg.requestId);
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

    this.markPendingReviewConsumed(msg.requestId);

    await this.runChatRequest(ws, {
      kind: 'resume',
      requestId: msg.requestId,
      resume: {
        reviewId: msg.reviewId,
        selectedOptionId: msg.selectedOptionId,
        ...(msg.input ? { input: msg.input } : {}),
      },
    }, deps, {
      type: 'human_review_response',
      reviewId: msg.reviewId,
      selectedOptionId: msg.selectedOptionId,
    });
  }

  async handleInterruptRequest(
    ws: WebSocket,
    msg: InterruptRequestMessage,
    deps: LocalServerDeps,
  ) {
    const route = await this.readPendingReviewRoute(msg.requestId, deps);
    if (!route) {
      return false;
    }
    if (!this.claimPendingReviewRequest(msg.requestId)) {
      return true;
    }

    const activeSessionId = this.tuiSessions.getActiveSessionId(deps.actorId);
    if (route.sessionId && activeSessionId && route.sessionId !== activeSessionId) {
      this.releasePendingReviewRequest(msg.requestId);
      console.warn(
        `[local-server] interrupt_request rejected: route sessionId=${route.sessionId} `
        + `does not match active session=${activeSessionId}`,
      );
      sendLocalAgentEvent(ws, {
        type: 'error',
        requestId: msg.requestId,
        message: '请回到发起该 review 的会话再打断。',
      });
      return true;
    }

    if (!route.rejectOptionId) {
      this.releasePendingReviewRequest(msg.requestId);
      console.warn(
        `[local-server] interrupt_request rejected: pending review=${route.reviewId} has no reject option`,
      );
      sendLocalAgentEvent(ws, {
        type: 'system.notice',
        requestId: msg.requestId,
        message: '当前 review 没有可用的拒绝选项，无法自动取消。',
      });
      sendLocalAgentEvent(ws, {
        type: 'human_review.requested',
        requestId: msg.requestId,
        review: route.review,
        ...(route.actor ? { actor: route.actor } : {}),
      });
      return true;
    }

    this.markPendingReviewConsumed(msg.requestId);
    console.log(
      `[local-server] interrupt pending human_review requestId=${msg.requestId} reviewId=${route.reviewId}`,
    );

    await this.runChatRequest(ws, {
      kind: 'resume',
      requestId: msg.requestId,
      resume: {
        reviewId: route.reviewId,
        selectedOptionId: route.rejectOptionId,
      },
    }, deps, {
      type: 'interrupt_request',
      reviewId: route.reviewId,
      selectedOptionId: route.rejectOptionId,
    });
    return true;
  }

  private sendStreamToolOperationEvent(
    ws: WebSocket,
    inflight: InflightRequest,
    payload: StreamToolsPayload,
  ) {
    emitLocalServerToolOperationEvent({
      run: inflight,
      payload,
      // Local TUI socket: include raw input/output so the UI can render diffs etc.
      emit: (event) => sendLocalAgentEvent(ws, event, { includeRaw: true }),
    });
  }
}
