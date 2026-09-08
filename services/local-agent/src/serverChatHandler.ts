import {
  projectHumanReviewRequest,
  type AbortSettlement,
  type ReviewSpec,
} from '@pinpawo/pet-agent';
import { loadAgentContext } from './contextLoader';
import {
  type ChatRequestMessage,
  type InterruptResumeMessage,
  type RunInterruptMessage,
} from './localAgentProtocol';
import { recordAgentRunActivity } from './operationActivityState';
import {
  type StreamToolsPayload,
} from './agentStreamEvents';
import {
  runAgentSessionTurn,
  type AgentSessionTurnRequest,
} from './chatSessionAdapter';
import {
  configureInflightOperationRegistry,
  overlayInflightDelegationOperations,
  type InflightOperationRun,
} from './inflightOperationRun';
import { InflightRequestController } from './inflightRequestController';
import { emitLocalServerToolOperationEvent } from './serverOperationEvents';
import { LocalAgentGraphService } from './agentGraphService';
import {
  ServerTuiSessionService,
  type ActivePendingInterrupt,
} from './serverTuiSessions';
import type { ServerDeps } from './serverTypes';
import { createOperationRegistryForAgentSetup } from './runtimeOperationRegistry';
import {
  resolvePendingHumanReviewInterrupt,
  type PendingHumanReviewInterruptRoute,
  type HumanReviewResolutionSource,
} from './pendingHumanReviewInterrupt';
import type { AgentRuntimeEvent, PendingInterruptProjection } from '@pinpawo/agent-session';
import {
  classifyAgentRunFailure,
  describeFatalAgentRunFailure,
} from './agentRunFailure';
import { sendLocalServerPeerEvent, type ServerPeer } from './localServerPeer';
import { ThreadInvocationCoordinator } from './threadInvocationCoordinator';

type InflightRequest = InflightOperationRun;

type LocalServerRunRequest = AgentSessionTurnRequest;
type RunAgentSessionTurn = typeof runAgentSessionTurn;
type ChatRunOutcome =
  | 'completed'
  | 'waiting'
  | 'interrupted'
  | 'failed'
  | 'fatal_failed';

type LocalServerRunSource =
  | { type: 'chat_request' }
  | HumanReviewResolutionSource;

type PendingInterruptRoute = PendingHumanReviewInterruptRoute & {
  requestId: string;
  sessionId?: string;
};

export type PendingInterruptSnapshot = {
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

export class ServerChatHandler {
  private readonly graphService: LocalAgentGraphService;
  private readonly tuiSessions: ServerTuiSessionService;
  private readonly inflightRequests: InflightRequestController<ServerPeer>;
  private readonly loadContext: typeof loadAgentContext;
  private readonly runAgentTurn: RunAgentSessionTurn;
  private readonly publishRuntimeEvent: (
    origin: ServerPeer,
    event: AgentRuntimeEvent,
  ) => void;
  private readonly interruptHostRun?: (requestId: string) => boolean;
  private readonly threadInvocations = new ThreadInvocationCoordinator();

  constructor(options: {
    graphService: LocalAgentGraphService;
    tuiSessions: ServerTuiSessionService;
    inflightRequests: InflightRequestController<ServerPeer>;
    loadContext?: typeof loadAgentContext;
    runAgentTurn?: RunAgentSessionTurn;
    publishRuntimeEvent?: (
      origin: ServerPeer,
      event: AgentRuntimeEvent,
    ) => void;
    interruptHostRun?: (requestId: string) => boolean;
  }) {
    this.graphService = options.graphService;
    this.tuiSessions = options.tuiSessions;
    this.inflightRequests = options.inflightRequests;
    this.loadContext = options.loadContext ?? loadAgentContext;
    this.runAgentTurn = options.runAgentTurn ?? runAgentSessionTurn;
    this.publishRuntimeEvent = options.publishRuntimeEvent
      ?? ((peer, event) => {
        sendLocalServerPeerEvent(peer, event);
      });
    this.interruptHostRun = options.interruptHostRun;
  }

  private buildPendingInterruptRoute(params: {
    requestId: string;
    interruptId: string;
    reviews: ReviewSpec[];
    sessionId?: string;
  }): PendingInterruptRoute {
    return {
      requestId: params.requestId,
      interruptId: params.interruptId,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      reviews: params.reviews,
    };
  }

  private async recoverPendingInterruptRoute(
    requestId: string,
    deps: ServerDeps,
  ) {
    try {
      const pending = await this.tuiSessions.readActivePendingInterrupt(deps);
      // Review resolution needs the reviews themselves. A pause has none and
      // is continued by id instead, so it is not a route.
      if (!pending || pending.payload.kind !== 'human_review') {
        return null;
      }
      const route = this.buildPendingInterruptRoute({
        requestId,
        interruptId: pending.interruptId,
        reviews: pending.payload.reviews,
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
    _deps: ServerDeps,
    pending: ActivePendingInterrupt | null,
  ): PendingInterruptSnapshot | null {
    if (!pending) {
      return null;
    }
    return {
      sessionId: pending.sessionId,
      pendingInterrupt: {
        interruptId: pending.interruptId,
        payload: pending.payload.kind === 'human_review'
          ? {
              kind: 'human_review',
              interactions: pending.payload.reviews.map(projectHumanReviewRequest),
            }
          : { kind: 'pause_task' },
      },
    };
  }

  private sendClosedReviewError(peer: ServerPeer, requestId: string) {
    sendLocalServerPeerEvent(peer, {
      type: 'error',
      requestId,
      message: '这个 review 已关闭或不存在，请等待当前确认面板刷新后再应答。',
      code: 'interrupt_closed',
    });
  }

  async handleChatRequest(
    peer: ServerPeer,
    msg: ChatRequestMessage,
    deps: ServerDeps,
  ) {
    await this.runChatRequest(peer, {
      kind: 'user_message',
      requestId: msg.requestId,
      message: msg.message,
      ...(msg.attachments ? { attachments: msg.attachments } : {}),
    }, deps, { type: 'chat_request' });
  }

  /**
   * The one resume entry point. Identity is checked here; the value belongs to
   * the interrupt's kind. A review's value is validated against the
   * authoritative checkpoint first, because a malformed decision would leave a
   * tool call unanswered.
   */
  async handleInterruptResume(
    peer: ServerPeer,
    msg: InterruptResumeMessage,
    deps: ServerDeps,
  ) {
    const pending = await this.tuiSessions.readActivePendingInterrupt(deps);
    if (!pending || pending.interruptId !== msg.interruptId) {
      this.sendClosedReviewError(peer, msg.requestId);
      return;
    }
    if (pending.payload.kind === 'human_review') {
      await this.resolvePendingReview(peer, msg, deps);
      return;
    }
    await this.runChatRequest(peer, {
      kind: 'resume',
      requestId: msg.requestId,
      resume: { [msg.interruptId]: msg.value },
    }, deps, { type: 'chat_request' });
  }

  async handleRunInterrupt(
    peer: ServerPeer,
    msg: RunInterruptMessage,
    deps: ServerDeps,
  ) {
    const inflight = this.inflightRequests.interrupt(peer, { requestId: msg.requestId });
    if (inflight) {
      return inflight;
    }
    if (this.interruptHostRun?.(msg.requestId)) {
      peer.send({
        type: 'interrupting',
        requestId: msg.requestId,
        message: 'interrupting',
      });
      return { requestId: msg.requestId };
    }
    // No run is in flight, so the run already settled into an interrupt before
    // the interface observed it. Re-announce that interrupt and stop: the Host
    // must not turn a stop request into a resume decision on the person's
    // behalf. The interface reconciles and the person acts on what is pending.
    const pending = await this.tuiSessions.readActivePendingInterrupt(deps);
    const snapshot = pending
      ? this.buildPendingInterruptSnapshot(deps, pending)
      : null;
    if (snapshot) {
      this.publishRuntimeEvent(peer, {
        type: 'interrupt.requested',
        requestId: msg.requestId,
        pendingInterrupt: snapshot.pendingInterrupt,
      });
    }
    return null;
  }

  private async runChatRequest(
    peer: ServerPeer,
    request: LocalServerRunRequest,
    deps: ServerDeps,
    source: LocalServerRunSource,
  ): Promise<ChatRunOutcome> {
    const { requestId } = request;
    const message = request.kind === 'user_message' ? request.message : '';

    if (source.type === 'chat_request') {
      console.log(`[local-server] chat_request requestId=${requestId} message="${message.slice(0, 80)}"`);
    } else if (source.type === 'review_decision') {
      console.log(
        `[local-server] review decision requestId=${requestId} `
        + `interactionId=${source.interactionId} option=${source.selectedOptionId}`
        + (source.decisionCount ? ` decisions=${source.decisionCount}` : ''),
      );
    } else {
      console.log(
        `[local-server] review cancel requestId=${requestId} `
        + `interactionId=${source.interactionId} action=interrupt_run`,
      );
    }
    const threadId = this.tuiSessions.getChatThreadId(deps.petId);
    const inflight = this.inflightRequests.start(peer, requestId);
    const { controller } = inflight;
    const invocation = this.threadInvocations.enqueue({
      threadId,
      requestId,
      signal: controller.signal,
      abort: () => controller.abort(),
    });
    const isCurrent = invocation.isCurrent;
    let runStarted = false;
    let interruptedFinalized = false;
    /**
     * A cancelled run that left unfinished work becomes a task pause, so it is
     * continued by id like any other interrupt. The Runtime owns whether that
     * applies and how; the Host only asks and reports what came back.
     */
    const settleInterrupted = async (): Promise<ChatRunOutcome> => {
      let settled: AbortSettlement = { status: 'finished' };
      try {
        const setup = this.tuiSessions.buildChatSetup(deps, await this.loadContext(deps.actorId), threadId);
        settled = await this.graphService.settleAbortedRun(setup);
      } catch (settleError) {
        console.warn(
          '[local-server] failed to settle an aborted run:',
          settleError instanceof Error ? settleError.message : settleError,
        );
      }
      if (settled.status === 'paused') {
        this.inflightRequests.finish(peer, inflight, 'interrupted');
        this.publishRuntimeEvent(peer, {
          type: 'interrupt.requested',
          requestId,
          pendingInterrupt: this.buildPendingInterruptSnapshot(deps, {
            sessionId: this.tuiSessions.getActiveSessionId(deps.actorId) ?? '',
            ...settled.pendingInterrupt,
          })!.pendingInterrupt,
        });
        this.inflightRequests.clear(peer, inflight);
        await this.tuiSessions.refreshActiveSessionSummary(deps);
        return 'waiting';
      }
      finalizeInterrupted();
      return 'interrupted';
    };
    // The one interrupted finalization for this request. An abort, a
    // superseding request, and a run that settled into a task pause all end
    // here: open operations close first, then the run reports interrupted.
    const finalizeInterrupted = () => {
      if (interruptedFinalized) return;
      interruptedFinalized = true;
      this.inflightRequests.finish(peer, inflight, 'interrupted');
      if (runStarted) {
        this.publishRuntimeEvent(peer, {
          type: 'run.interrupted',
          requestId,
          message: 'Run interrupted.',
        });
      }
      this.inflightRequests.clear(peer, inflight);
    };

    try {
      await invocation.waitForTurn();
      if (!isCurrent()) {
        finalizeInterrupted();
        return 'interrupted';
      }
      this.publishRuntimeEvent(peer, {
        type: 'run.started',
        requestId,
        initiator: 'client',
        ...(request.kind === 'user_message'
          ? { input: { role: 'user', text: request.message } as const }
          : {}),
      });
      runStarted = true;
      recordAgentRunActivity('thinking', requestId);
      const ctx = await this.loadContext(deps.petId);
      if (!isCurrent()) {
        finalizeInterrupted();
        return 'interrupted';
      }

      const setup = this.tuiSessions.buildChatSetup(deps, ctx, threadId);
      configureInflightOperationRegistry(
        inflight,
        createOperationRegistryForAgentSetup(setup),
      );
      setup.input.signal = controller.signal;
      const result = await this.runAgentTurn({
        request,
        setup,
        graphService: this.graphService,
        isCurrent,
        emitEvent: (event) => {
          if (!isCurrent()) return;
          this.publishRuntimeEvent(peer, event);
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
      });
      if (result.status === 'waiting') {
        // Every kind settles here. The run's own operations close, and the
        // interrupt.requested event already told the interface what it is
        // waiting on and under which id.
        this.inflightRequests.finish(peer, inflight, 'interrupted');
        await this.tuiSessions.refreshActiveSessionSummary(deps);
        console.log(`[local-server] interrupt.requested requestId=${requestId}`);
        this.inflightRequests.clear(peer, inflight);
        return 'waiting';
      }
      if (result.status === 'interrupted') {
        return await settleInterrupted();
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
        recordAgentRunActivity('interrupted', requestId, 2_500);
        return await settleInterrupted();
      }
      this.inflightRequests.finish(peer, inflight, 'failed', err);
      this.inflightRequests.clear(peer, inflight);
      recordAgentRunActivity('error', requestId, 5_000);
      console.error('[local-server] chat error:', err instanceof Error ? (err.stack ?? err.message) : err);
      const recoveredFromToolProtocolError = isToolProtocolHistoryError(err);
      if (recoveredFromToolProtocolError) {
        try {
          await this.tuiSessions.resetSession(deps.petId, {
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
      if (isStillCurrent) {
        const message = err instanceof Error ? err.message : 'internal error';
        this.publishRuntimeEvent(peer, {
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

  private async resolvePendingReview(
    peer: ServerPeer,
    msg: InterruptResumeMessage,
    deps: ServerDeps,
  ) {
    await resolvePendingHumanReviewInterrupt({
      message: msg,
      recover: () => this.recoverPendingInterruptRoute(msg.requestId, deps),
      emitClosed: () => {
        console.warn(
          `[local-server] interrupt.resume rejected: checkpoint has no matching pending interrupt requestId=${msg.requestId}`,
        );
        this.sendClosedReviewError(peer, msg.requestId);
      },
      emitEvent: (event) => {
        this.publishRuntimeEvent(peer, event);
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
    peer: ServerPeer,
    route: PendingInterruptRoute,
    message: InterruptResumeMessage,
    deps: ServerDeps,
  ) {
    const activeSessionId = this.tuiSessions.getActiveSessionId(deps.petId);
    if (route.sessionId && activeSessionId && route.sessionId !== activeSessionId) {
      console.warn(
        `[local-server] interrupt.resume rejected: route sessionId=${route.sessionId} `
        + `does not match active session=${activeSessionId}`,
      );
      sendLocalServerPeerEvent(peer, {
        type: 'error',
        requestId: message.requestId,
        message: '请回到发起该 review 的会话再操作。',
        code: 'interrupt_wrong_session',
      });
      return false;
    }
    return true;
  }

  private sendStreamToolOperationEvent(
    peer: ServerPeer,
    inflight: InflightRequest,
    payload: StreamToolsPayload,
  ) {
    emitLocalServerToolOperationEvent({
      run: inflight,
      payload,
      // Trusted local peer: include raw input/output so the UI can render diffs etc.
      emit: (event) => this.publishRuntimeEvent(peer, event),
    });
  }
}
