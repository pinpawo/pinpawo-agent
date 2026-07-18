import type { ReviewResponse, ReviewSpec } from '@pinpawo/pet-agent';
import { loadAgentContext } from './contextLoader';
import {
  type ChatRequestMessage,
  type HumanReviewResponseMessage,
  type ReviewCancelMessage,
  type RunInterruptMessage,
} from './localAgentProtocol';
import { recordAgentRunActivity } from './operationActivityState';
import {
  type StreamToolsPayload,
} from './agentStreamEvents';
import { runChatSession, type ChatSessionRequest } from './chatSessionAdapter';
import {
  configureInflightOperationRegistry,
  overlayInflightDelegationOperations,
  type InflightOperationRun,
} from './inflightOperationRun';
import { InflightRequestController } from './inflightRequestController';
import { emitLocalServerToolOperationEvent } from './localServerOperationEvents';
import { LocalAgentGraphService } from './agentGraphService';
import {
  LocalServerTuiSessionService,
  type ActivePendingReview,
} from './localServerTuiSessions';
import type { LocalServerDeps } from './localServerTypes';
import { createOperationRegistryForAgentSetup } from './runtimeOperationRegistry';
import type { LocalAgentRuntimeEvent } from './events/localAgentRuntimeEvent';
import {
  buildHumanReviewRejectResume,
  buildHumanReviewResume,
  matchesHumanReviewAction,
  validateHumanReviewDecisions,
  type HumanReviewActionRoute,
} from './humanReviewActionRouting';
import {
  reviewActionId,
  reviewActionReviews,
  type ReviewAction,
} from './reviewAction';
import { RunCommandSequencer } from './runCommandSequencer';
import { sendLocalServerPeerEvent, type LocalServerPeer } from './localServerPeer';

type InflightRequest = InflightOperationRun;

type LocalServerRunRequest = ChatSessionRequest;
type RunChatSession = typeof runChatSession;

type LocalServerRunSource =
  | { type: 'chat_request' }
  | { type: 'human_review_response'; reviewId: string; selectedOptionId: string; decisionCount?: number }
  | { type: 'review.cancel'; reviewId: string; selectedOptionId: string; decisionCount?: number };

type ReviewActionRoute = HumanReviewActionRoute & {
  rejectOptionId?: string;
  sessionId?: string;
  actor?: Extract<LocalAgentRuntimeEvent, { type: 'human_review.requested' }>['actor'];
};

export type ReviewActionSnapshot = {
  requestId: string;
  sessionId?: string;
  reviewAction: ReviewAction;
  actor?: Extract<LocalAgentRuntimeEvent, { type: 'human_review.requested' }>['actor'];
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
  private readonly inflightRequests: InflightRequestController<LocalServerPeer>;
  private readonly loadContext: typeof loadAgentContext;
  private readonly runChat: RunChatSession;
  private readonly reviewActionRoutes = new Map<string, ReviewActionRoute>();
  private readonly consumedPendingReviewRequestIds = new Set<string>();
  private readonly activePendingReviewRequestIds = new Set<string>();
  private readonly runCommandSequencer = new RunCommandSequencer();

  constructor(options: {
    graphService: LocalAgentGraphService;
    tuiSessions: LocalServerTuiSessionService;
    inflightRequests: InflightRequestController<LocalServerPeer>;
    loadContext?: typeof loadAgentContext;
    runChat?: RunChatSession;
  }) {
    this.graphService = options.graphService;
    this.tuiSessions = options.tuiSessions;
    this.inflightRequests = options.inflightRequests;
    this.loadContext = options.loadContext ?? loadAgentContext;
    this.runChat = options.runChat ?? runChatSession;
  }

  private buildReviewActionRoute(params: {
    requestId: string;
    interruptId?: string;
    review: ReviewSpec;
    reviews?: ReviewSpec[];
    sessionId?: string;
    actor?: ReviewActionRoute['actor'];
  }): ReviewActionRoute {
    const reviews = reviewActionReviews(params.review, params.reviews);
    const rejectOption = reviews[0]?.options.find((option) => option.decision.type === 'reject');
    return {
      ...(params.interruptId ? { interruptId: params.interruptId } : {}),
      actionId: reviewActionId({
        requestId: params.requestId,
        ...(params.interruptId ? { interruptId: params.interruptId } : {}),
        reviews,
      }),
      ...(rejectOption ? { rejectOptionId: rejectOption.id } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      reviews,
      ...(params.actor ? { actor: params.actor } : {}),
    };
  }

  private recordReviewActionRoute(
    event: LocalAgentRuntimeEvent,
    deps: LocalServerDeps,
  ) {
    if (event.type !== 'human_review.requested' || !event.review?.id) {
      return;
    }
    this.consumedPendingReviewRequestIds.delete(event.requestId);
    this.activePendingReviewRequestIds.delete(event.requestId);
    const sessionId = this.tuiSessions.getActiveSessionId(deps.actorId);
    this.reviewActionRoutes.set(event.requestId, this.buildReviewActionRoute({
      requestId: event.requestId,
      ...(event.interruptId ? { interruptId: event.interruptId } : {}),
      review: event.review,
      ...(event.reviews ? { reviews: event.reviews } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(event.actor ? { actor: event.actor } : {}),
    }));
  }

  private async recoverReviewActionRoute(
    requestId: string,
    deps: LocalServerDeps,
  ) {
    try {
      const pending = await this.tuiSessions.readActivePendingReview(deps);
      if (!pending) {
        return null;
      }
      const route = this.buildReviewActionRoute({
        requestId,
        ...(pending.interruptId ? { interruptId: pending.interruptId } : {}),
        review: pending.review,
        ...(pending.reviews ? { reviews: pending.reviews } : {}),
        sessionId: pending.sessionId,
      });
      this.reviewActionRoutes.set(requestId, route);
      return route;
    } catch (err) {
      console.warn(
        '[local-server] failed to recover pending human_review from checkpoint:',
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  private async readReviewActionRoute(
    requestId: string,
    deps: LocalServerDeps,
  ) {
    const route = this.reviewActionRoutes.get(requestId);
    if (route) {
      return route;
    }
    if (this.consumedPendingReviewRequestIds.has(requestId)) {
      return null;
    }
    return this.recoverReviewActionRoute(requestId, deps);
  }

  private claimPendingReviewRequest(requestId: string) {
    if (
      this.consumedPendingReviewRequestIds.has(requestId)
      || this.activePendingReviewRequestIds.has(requestId)
    ) {
      return false;
    }
    this.activePendingReviewRequestIds.add(requestId);
    this.runCommandSequencer.beginReviewResolution(requestId);
    return true;
  }

  private releasePendingReviewRequest(requestId: string) {
    this.activePendingReviewRequestIds.delete(requestId);
    this.runCommandSequencer.abandonReviewResolution(requestId);
  }

  private markPendingReviewConsumed(requestId: string) {
    this.reviewActionRoutes.delete(requestId);
    this.activePendingReviewRequestIds.delete(requestId);
    this.consumedPendingReviewRequestIds.add(requestId);
    while (this.consumedPendingReviewRequestIds.size > MAX_CONSUMED_PENDING_REVIEW_REQUEST_IDS) {
      const oldest = this.consumedPendingReviewRequestIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.consumedPendingReviewRequestIds.delete(oldest);
    }
  }

  buildReviewActionSnapshot(
    deps: LocalServerDeps,
    pending: ActivePendingReview | null,
  ): ReviewActionSnapshot | null {
    const activeSessionId = this.tuiSessions.getActiveSessionId(deps.actorId);
    for (const [requestId, route] of this.reviewActionRoutes) {
      if (route.sessionId && activeSessionId && route.sessionId !== activeSessionId) {
        continue;
      }
      return {
        requestId,
        ...(route.sessionId ? { sessionId: route.sessionId } : {}),
        reviewAction: {
          actionId: route.actionId,
          reviews: route.reviews,
        },
        ...(route.actor ? { actor: route.actor } : {}),
      };
    }

    if (!pending) {
      return null;
    }
    const requestId = `snapshot:${pending.sessionId}:${pending.review.id}`;
    const route = this.buildReviewActionRoute({
      requestId,
      ...(pending.interruptId ? { interruptId: pending.interruptId } : {}),
      review: pending.review,
      ...(pending.reviews ? { reviews: pending.reviews } : {}),
      sessionId: pending.sessionId,
    });
    this.reviewActionRoutes.set(requestId, route);
    return {
      requestId,
      sessionId: pending.sessionId,
      reviewAction: {
        actionId: route.actionId,
        reviews: route.reviews,
      },
    };
  }

  private sendClosedReviewError(peer: LocalServerPeer, requestId: string) {
    sendLocalServerPeerEvent(peer, {
      type: 'error',
      requestId,
      message: '这个 review 已关闭或不存在，请等待当前确认面板刷新后再应答。',
      code: 'review_closed',
    });
  }

  async handleChatRequest(
    peer: LocalServerPeer,
    msg: ChatRequestMessage,
    deps: LocalServerDeps,
  ) {
    return this.runChatRequest(peer, {
      kind: 'user_message',
      requestId: msg.requestId,
      message: msg.message,
    }, deps, { type: 'chat_request' });
  }

  handleRunInterrupt(peer: LocalServerPeer, msg: RunInterruptMessage) {
    const inflight = this.inflightRequests.interrupt(peer, { requestId: msg.requestId });
    if (inflight) {
      return inflight;
    }
    this.runCommandSequencer.queueRunInterrupt(msg.requestId);
    return null;
  }

  private async runChatRequest(
    peer: LocalServerPeer,
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
        + `reviewId=${source.reviewId} option=${source.selectedOptionId}`
        + (source.decisionCount ? ` decisions=${source.decisionCount}` : ''),
      );
    } else {
      console.log(
        `[local-server] review.cancel resume human_review requestId=${requestId} `
        + `reviewId=${source.reviewId} option=${source.selectedOptionId}`
        + (source.decisionCount ? ` decisions=${source.decisionCount}` : ''),
      );
    }
    recordAgentRunActivity('thinking', requestId);

    const previousInflight = this.inflightRequests.get(peer);
    const inflight = this.inflightRequests.start(peer, requestId, {
      interruptPrevious: true,
      notifyPrevious: true,
    });
    if (previousInflight) {
      console.warn(`[local-server] abort previous inflight requestId=${previousInflight.requestId} before starting requestId=${requestId}`);
    }
    const { controller } = inflight;
    const isCurrent = () => this.inflightRequests.isCurrentActive(peer, inflight);
    const finishInterrupted = () => {
      if (!controller.signal.aborted) {
        return;
      }
      this.inflightRequests.sendInterrupted(peer, inflight);
      this.inflightRequests.clear(peer, inflight);
    };

    try {
      const ctx = await this.loadContext(deps.actorId);
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
      const result = await this.runChat({
        request,
        setup,
        graphService: this.graphService,
        isCurrent,
        finishInterrupted,
        emitEvent: (event) => {
          this.recordReviewActionRoute(event, deps);
          sendLocalServerPeerEvent(peer, event);
        },
        emitToolEvent: (event) => {
          this.sendStreamToolOperationEvent(peer, inflight, event);
        },
        acceptDelegationOperations: (operations) => {
          overlayInflightDelegationOperations(inflight, operations);
        },
        ...(source.type !== 'chat_request'
          ? {
            onResumeCheckpointed: ({ canInterrupt }: { canInterrupt: boolean }) => {
              const interruptQueued = this.runCommandSequencer
                .markReviewResolutionCheckpointed(requestId);
              if (canInterrupt && interruptQueued) {
                this.inflightRequests.interrupt(peer, { requestId });
              }
            },
          }
          : {}),
      });
      if (result.status === 'waiting_human') {
        this.inflightRequests.finish(peer, inflight, 'interrupted');
        await this.tuiSessions.refreshActiveSessionSummary(deps);
        console.log(`[local-server] human_review.requested requestId=${requestId}`);
        this.inflightRequests.clear(peer, inflight);
        return;
      }
      if (result.status === 'interrupted') {
        return;
      }
      this.inflightRequests.finish(peer, inflight, 'completed');
      this.inflightRequests.clear(peer, inflight);
      await this.tuiSessions.refreshActiveSessionSummary(deps);

      console.log(`[local-server] message.completed sent requestId=${requestId} reply="${result.reply.slice(0, 100)}"`);
    } catch (err) {
      const isStillCurrent = this.inflightRequests.isCurrent(peer, inflight);
      const aborted = controller.signal.aborted
        || (err instanceof Error && err.name === 'AbortError');
      if (aborted) {
        console.warn(`[local-server] chat interrupted requestId=${requestId}`);
        this.inflightRequests.sendInterrupted(peer, inflight);
        recordAgentRunActivity('interrupted', requestId, 2_500);
        this.inflightRequests.clear(peer, inflight);
        return;
      }
      this.inflightRequests.finish(peer, inflight, 'failed', err);
      this.inflightRequests.clear(peer, inflight);
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
      if (isStillCurrent && peer.isConnected()) {
        const message = err instanceof Error ? err.message : 'internal error';
        sendLocalServerPeerEvent(peer, {
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
    peer: LocalServerPeer,
    msg: HumanReviewResponseMessage,
    deps: LocalServerDeps,
  ) {
    if (!this.claimPendingReviewRequest(msg.requestId)) {
      console.warn(
        `[local-server] human_review_response rejected: pending review request already consumed or active requestId=${msg.requestId}`,
      );
      this.sendClosedReviewError(peer, msg.requestId);
      return;
    }

    const route = await this.readReviewActionRoute(msg.requestId, deps);
    if (!route) {
      this.releasePendingReviewRequest(msg.requestId);
      console.warn(
        `[local-server] human_review_response rejected: no pending review route for requestId=${msg.requestId}`,
      );
      this.sendClosedReviewError(peer, msg.requestId);
      return;
    }
    if (!matchesHumanReviewAction(route, msg.actionId)) {
      this.releasePendingReviewRequest(msg.requestId);
      sendLocalServerPeerEvent(peer, {
        type: 'error',
        requestId: msg.requestId,
        message: '这个 review action 已经过期，请等待当前确认面板刷新后再操作。',
        code: 'review_stale',
      });
      return;
    }
    let decisions: ReviewResponse[];
    try {
      decisions = validateHumanReviewDecisions(route, msg);
    } catch (err) {
      this.releasePendingReviewRequest(msg.requestId);
      console.warn(
        `[local-server] human_review_response rejected: reviewId=${msg.reviewId} `
        + `does not match pending review action=${route.reviews.map((review) => review.id).join(',')} `
        + (err instanceof Error ? err.message : String(err)),
      );
      sendLocalServerPeerEvent(peer, {
        type: 'error',
        requestId: msg.requestId,
        message: '这个 review 已经过期，请等待当前确认面板刷新后再应答。',
        code: 'review_stale',
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
      sendLocalServerPeerEvent(peer, {
        type: 'error',
        requestId: msg.requestId,
        message: '请回到发起该 review 的会话再应答。',
        code: 'review_wrong_session',
      });
      return;
    }

    if (!peer.isConnected()) {
      this.releasePendingReviewRequest(msg.requestId);
      return;
    }

    this.markPendingReviewConsumed(msg.requestId);

    try {
      await this.runChatRequest(peer, {
        kind: 'resume',
        requestId: msg.requestId,
        resume: buildHumanReviewResume(route, decisions),
      }, deps, {
        type: 'human_review_response',
        reviewId: msg.reviewId,
        selectedOptionId: msg.selectedOptionId,
        decisionCount: decisions.length,
      });
    } finally {
      this.runCommandSequencer.abandonReviewResolution(msg.requestId);
    }
  }

  async handleReviewCancel(
    peer: LocalServerPeer,
    msg: ReviewCancelMessage,
    deps: LocalServerDeps,
  ) {
    if (!this.claimPendingReviewRequest(msg.requestId)) {
      this.sendClosedReviewError(peer, msg.requestId);
      return;
    }
    const route = await this.readReviewActionRoute(msg.requestId, deps);
    if (!route) {
      this.releasePendingReviewRequest(msg.requestId);
      this.sendClosedReviewError(peer, msg.requestId);
      return;
    }
    if (!matchesHumanReviewAction(route, msg.actionId)) {
      this.releasePendingReviewRequest(msg.requestId);
      sendLocalServerPeerEvent(peer, {
        type: 'error',
        requestId: msg.requestId,
        message: '这个 review action 已经过期，请等待当前确认面板刷新后再操作。',
        code: 'review_stale',
      });
      return;
    }
    const activeSessionId = this.tuiSessions.getActiveSessionId(deps.actorId);
    if (route.sessionId && activeSessionId && route.sessionId !== activeSessionId) {
      this.releasePendingReviewRequest(msg.requestId);
      console.warn(
        `[local-server] review.cancel rejected: route sessionId=${route.sessionId} `
        + `does not match active session=${activeSessionId}`,
      );
      sendLocalServerPeerEvent(peer, {
        type: 'error',
        requestId: msg.requestId,
        message: '请回到发起该 review 的会话再打断。',
        code: 'review_wrong_session',
      });
      return;
    }

    if (!route.rejectOptionId) {
      const firstReview = route.reviews[0];
      this.releasePendingReviewRequest(msg.requestId);
      console.warn(
        `[local-server] review.cancel rejected: review action=${route.actionId} has no reject option`,
      );
      sendLocalServerPeerEvent(peer, {
        type: 'system.notice',
        requestId: msg.requestId,
        message: '当前 review 没有可用的拒绝选项，无法自动取消。',
      });
      sendLocalServerPeerEvent(peer, {
        type: 'human_review.requested',
        requestId: msg.requestId,
        ...(route.interruptId ? { interruptId: route.interruptId } : {}),
        review: firstReview!,
        reviews: route.reviews,
        ...(route.actor ? { actor: route.actor } : {}),
      });
      return;
    }

    if (!peer.isConnected()) {
      this.releasePendingReviewRequest(msg.requestId);
      return;
    }

    this.markPendingReviewConsumed(msg.requestId);
    const firstReview = route.reviews[0]!;
    console.log(
      `[local-server] cancel pending human_review requestId=${msg.requestId} actionId=${route.actionId}`,
    );

    try {
      await this.runChatRequest(peer, {
        kind: 'resume',
        requestId: msg.requestId,
        resume: buildHumanReviewRejectResume(route, route.rejectOptionId),
      }, deps, {
        type: 'review.cancel',
        reviewId: firstReview.id,
        selectedOptionId: route.rejectOptionId,
        decisionCount: 1,
      });
    } finally {
      this.runCommandSequencer.abandonReviewResolution(msg.requestId);
    }
  }

  private sendStreamToolOperationEvent(
    peer: LocalServerPeer,
    inflight: InflightRequest,
    payload: StreamToolsPayload,
  ) {
    emitLocalServerToolOperationEvent({
      run: inflight,
      payload,
      // Trusted local peer: include raw input/output so the UI can render diffs etc.
      emit: (event) => sendLocalServerPeerEvent(peer, event, { includeRaw: true }),
    });
  }
}
