import {
  projectHumanReviewRequest,
  type ReviewSpec,
} from '@pinpawo/pet-agent';
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
  type ActivePendingInterrupt,
} from './localServerTuiSessions';
import type { LocalServerDeps } from './localServerTypes';
import { createOperationRegistryForAgentSetup } from './runtimeOperationRegistry';
import {
  resolvePendingHumanReviewInterrupt,
  routeRunInterruptThroughHumanReview,
  type PendingHumanReviewInterruptRoute,
  type HumanReviewResolutionOutcome,
  type HumanReviewResolutionSource,
} from './pendingHumanReviewInterrupt';
import type { PendingInterruptProjection } from '@pinpawo/agent-session';
import {
  classifyAgentRunFailure,
  describeFatalAgentRunFailure,
} from './agentRunFailure';
import { sendLocalServerPeerEvent, type LocalServerPeer } from './localServerPeer';
import { ThreadInvocationCoordinator } from './threadInvocationCoordinator';

type InflightRequest = InflightOperationRun;

type LocalServerRunRequest = ChatSessionRequest;
type RunChatSession = typeof runChatSession;

type LocalServerRunSource =
  | { type: 'chat_request' }
  | HumanReviewResolutionSource;

type PendingInterruptRoute = PendingHumanReviewInterruptRoute & {
  requestId: string;
  rejectOptionId?: string;
  sessionId?: string;
};

export type PendingInterruptSnapshot = {
  requestId: string;
  sessionId?: string;
  pendingInterrupt: PendingInterruptProjection;
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
  private readonly inflightRequests: InflightRequestController<LocalServerPeer>;
  private readonly loadContext: typeof loadAgentContext;
  private readonly runChat: RunChatSession;
  private readonly threadInvocations = new ThreadInvocationCoordinator();

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

  private buildPendingInterruptRoute(params: {
    requestId: string;
    interruptId: string;
    review: ReviewSpec;
    reviews?: ReviewSpec[];
    sessionId?: string;
  }): PendingInterruptRoute {
    const reviews = params.reviews?.length ? params.reviews : [params.review];
    const rejectOption = reviews[0]?.options.find((option) => option.decision.type === 'reject');
    return {
      requestId: params.requestId,
      interruptId: params.interruptId,
      ...(rejectOption ? { rejectOptionId: rejectOption.id } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      reviews,
    };
  }

  private async recoverPendingInterruptRoute(
    requestId: string,
    deps: LocalServerDeps,
  ) {
    try {
      const pending = await this.tuiSessions.readActivePendingInterrupt(deps);
      if (!pending) {
        return null;
      }
      if (!pending.interruptId) {
        console.warn('[local-server] pending interrupt is missing interruptId');
        return null;
      }
      const route = this.buildPendingInterruptRoute({
        requestId,
        interruptId: pending.interruptId,
        review: pending.review,
        ...(pending.reviews ? { reviews: pending.reviews } : {}),
        sessionId: pending.sessionId,
      });
      return route;
    } catch (err) {
      console.warn(
        '[local-server] failed to recover pending human_review from checkpoint:',
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  buildPendingInterruptSnapshot(
    _deps: LocalServerDeps,
    pending: ActivePendingInterrupt | null,
  ): PendingInterruptSnapshot | null {
    if (!pending) {
      return null;
    }
    if (!pending.interruptId) {
      console.warn('[local-server] pending interrupt is missing interruptId');
      return null;
    }
    const requestId = pending.interruptId;
    const route = this.buildPendingInterruptRoute({
      requestId,
      interruptId: pending.interruptId,
      review: pending.review,
      ...(pending.reviews ? { reviews: pending.reviews } : {}),
      sessionId: pending.sessionId,
    });
    return {
      requestId: route.interruptId,
      sessionId: pending.sessionId,
      pendingInterrupt: {
        interruptId: route.interruptId,
        payload: {
          kind: 'human_review',
          interactions: route.reviews.map(projectHumanReviewRequest),
        },
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
    await this.runChatRequest(peer, {
      kind: 'user_message',
      requestId: msg.requestId,
      message: msg.message,
      ...(msg.attachments ? { attachments: msg.attachments } : {}),
      ...(msg.activeDelegationTransition
        ? { activeDelegationTransition: msg.activeDelegationTransition }
        : {}),
    }, deps, { type: 'chat_request' });
  }

  async handleRunInterrupt(
    peer: LocalServerPeer,
    msg: RunInterruptMessage,
    deps: LocalServerDeps,
  ) {
    const inflight = this.inflightRequests.interrupt(peer, { requestId: msg.requestId });
    if (inflight) {
      return inflight;
    }
    await routeRunInterruptThroughHumanReview({
      recover: () => this.recoverPendingInterruptRoute(msg.requestId, deps),
      cancelPending: (route) => this.handleReviewCancel(peer, {
        type: 'review.cancel',
        requestId: msg.requestId,
        interruptId: route.interruptId,
      }, deps),
    });
    return null;
  }

  private async runChatRequest(
    peer: LocalServerPeer,
    request: LocalServerRunRequest,
    deps: LocalServerDeps,
    source: LocalServerRunSource,
  ): Promise<HumanReviewResolutionOutcome> {
    const { requestId } = request;
    const message = request.kind === 'user_message' ? request.message : '';

    if (source.type === 'chat_request') {
      console.log(`[local-server] chat_request requestId=${requestId} message="${message.slice(0, 80)}"`);
    } else if (source.type === 'human_review_response') {
      console.log(
        `[local-server] human_review_response requestId=${requestId} `
        + `interactionId=${source.interactionId} option=${source.selectedOptionId}`
        + (source.decisionCount ? ` decisions=${source.decisionCount}` : ''),
      );
    } else {
      console.log(
        `[local-server] review.cancel resume human_review requestId=${requestId} `
        + `interactionId=${source.interactionId} action=interrupt_run`,
      );
    }
    const threadId = this.tuiSessions.getChatThreadId(deps.actorId);
    const inflight = this.inflightRequests.start(peer, requestId);
    const { controller } = inflight;
    const invocation = this.threadInvocations.enqueue({
      threadId,
      requestId,
      signal: controller.signal,
      abort: () => controller.abort(),
    });
    const isCurrent = invocation.isCurrent;
    const finishInterrupted = () => {
      if (!controller.signal.aborted) {
        return;
      }
      this.inflightRequests.sendInterrupted(peer, inflight);
      this.inflightRequests.clear(peer, inflight);
    };

    try {
      await invocation.waitForTurn();
      recordAgentRunActivity('thinking', requestId);
      const ctx = await this.loadContext(deps.actorId);
      if (!isCurrent()) {
        finishInterrupted();
        return 'interrupted';
      }

      const setup = this.tuiSessions.buildChatSetup(deps, ctx, threadId);
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
          if (!isCurrent()) return;
          sendLocalServerPeerEvent(peer, event);
        },
        emitToolEvent: (event) => {
          if (!isCurrent()) return;
          this.sendStreamToolOperationEvent(peer, inflight, event);
        },
        acceptDelegationOperations: (operations) => {
          if (!isCurrent()) return;
          overlayInflightDelegationOperations(inflight, operations);
        },
        ...(request.kind === 'user_message'
          ? {
              prepareUserMessage: () => this.tuiSessions.createUserMessage(
                deps,
                request.message,
                request.attachments ?? [],
              ),
            }
          : {}),
        ...(source.type === 'review.cancel'
          || (source.type === 'human_review_response' && source.interruptRun)
          ? { interruptOnSettledResumeCheckpoint: true }
          : {}),
        ...(source.type !== 'chat_request'
          ? {
            onResumeCheckpointed: ({ canInterrupt }: { canInterrupt: boolean }) => {
              if (canInterrupt) {
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
        return 'waiting_human';
      }
      if (result.status === 'interrupted') {
        finishInterrupted();
        return 'interrupted';
      }
      this.inflightRequests.finish(peer, inflight, 'completed');
      this.inflightRequests.clear(peer, inflight);
      await this.tuiSessions.refreshActiveSessionSummary(deps);

      console.log(`[local-server] message.completed sent requestId=${requestId} reply="${result.reply.slice(0, 100)}"`);
      return 'completed';
    } catch (err) {
      const isStillCurrent = isCurrent();
      const aborted = controller.signal.aborted
        || (err instanceof Error && err.name === 'AbortError');
      if (aborted) {
        console.warn(`[local-server] chat interrupted requestId=${requestId}`);
        this.inflightRequests.sendInterrupted(peer, inflight);
        recordAgentRunActivity('interrupted', requestId, 2_500);
        this.inflightRequests.clear(peer, inflight);
        return 'interrupted';
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
      const failure = classifyAgentRunFailure(err);
      if (isStillCurrent && peer.isConnected()) {
        const message = err instanceof Error ? err.message : 'internal error';
        sendLocalServerPeerEvent(peer, {
          type: 'error',
          requestId,
          message: recoveredFromToolProtocolError
            ? `${message}\n\n已重置本地 TUI 会话，下一条消息会从新的后端会话继续。`
            : failure.kind === 'fatal'
              ? describeFatalAgentRunFailure(failure)
              : message,
          ...(failure.kind === 'fatal' ? { code: 'agent_unavailable' } : {}),
        });
      }
      return failure.kind === 'fatal' ? 'fatal_failed' : 'failed';
    } finally {
      invocation.settle();
    }
  }

  async handleHumanReviewResponse(
    peer: LocalServerPeer,
    msg: HumanReviewResponseMessage,
    deps: LocalServerDeps,
  ) {
    await this.resolvePendingInterrupt(peer, msg, deps);
  }

  async handleReviewCancel(
    peer: LocalServerPeer,
    msg: ReviewCancelMessage,
    deps: LocalServerDeps,
  ) {
    await this.resolvePendingInterrupt(peer, msg, deps);
  }

  private async resolvePendingInterrupt(
    peer: LocalServerPeer,
    msg: HumanReviewResponseMessage | ReviewCancelMessage,
    deps: LocalServerDeps,
  ) {
    await resolvePendingHumanReviewInterrupt({
      message: msg,
      recover: () => this.recoverPendingInterruptRoute(msg.requestId, deps),
      emitClosed: () => {
        if (msg.type === 'human_review_response') {
          console.warn(
            `[local-server] human_review_response rejected: pending review request already consumed or active requestId=${msg.requestId}`,
          );
        }
        this.sendClosedReviewError(peer, msg.requestId);
      },
      emitEvent: (event) => {
        sendLocalServerPeerEvent(peer, event);
      },
      acceptRoute: (route) => this.acceptReviewRoute(peer, route, msg, deps),
      isConnected: peer.isConnected,
      run: (route, resume, source) => this.runChatRequest(peer, {
        kind: 'resume',
        requestId: msg.requestId,
        resume,
      }, deps, source),
    });
  }

  private acceptReviewRoute(
    peer: LocalServerPeer,
    route: PendingInterruptRoute,
    message: HumanReviewResponseMessage | ReviewCancelMessage,
    deps: LocalServerDeps,
  ) {
    const activeSessionId = this.tuiSessions.getActiveSessionId(deps.actorId);
    if (route.sessionId && activeSessionId && route.sessionId !== activeSessionId) {
      console.warn(
        `[local-server] ${message.type} rejected: route sessionId=${route.sessionId} `
        + `does not match active session=${activeSessionId}`,
      );
      sendLocalServerPeerEvent(peer, {
        type: 'error',
        requestId: message.requestId,
        message: message.type === 'review.cancel'
          ? '请回到发起该 review 的会话再打断。'
          : '请回到发起该 review 的会话再应答。',
        code: 'review_wrong_session',
      });
      return false;
    }
    return true;
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
      emit: (event) => sendLocalServerPeerEvent(peer, event),
    });
  }
}
