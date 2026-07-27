import { WebSocket } from 'ws';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type {
  AgentCapability,
  AgentToolkit,
  CapabilityArtifactStore,
  ReviewSpec,
} from '@pinpawo/pet-agent';
import { buildLocalChatAgentInput, type AgentChannelSetup } from './agentChannel';
import { createCapabilityDiagnosticReporter } from './agentRegistryPreparation';
import { loadAgentContext, type AgentContext } from './contextLoader';
import { buildLocalLlmConfig } from './llmConfig';
import type { AgentLlmConfig } from './agentConfig';
import type { LoadedUserCapability } from './capabilityLoader';
import { buildAppChatThreadId } from './chatInterface';
import {
  redactRemoteCompletedMessagePaths,
  sendLocalAgentEvent,
  type ChatRequestMessage,
  type HumanReviewResponseMessage,
  type NewSessionMessage,
  type ReviewCancelMessage,
  type RunInterruptMessage,
  type StudioRequestMessage,
} from './localAgentProtocol';
import { recordAgentRunActivity } from './operationActivityState';
import type { StreamToolsPayload } from './agentStreamEvents';
import { runChatSession, type ChatSessionRequest } from './chatSessionAdapter';
import type { LocalAgentGraphService } from './agentGraphService';
import {
  configureInflightOperationRegistry,
  overlayInflightDelegationOperations,
  emitInflightToolEvent,
  type InflightOperationRun,
} from './inflightOperationRun';
import { InflightRequestController } from './inflightRequestController';
import { createOperationRegistryForAgentSetup } from './runtimeOperationRegistry';
import type { AgentRuntimeEvent } from '@pinpawo/agent-session';
import {
  resolveHumanReviewAction,
  type HumanReviewActionRoute,
  type HumanReviewResolutionOutcome,
  type HumanReviewResolutionSource,
} from './humanReviewActionRouting';
import { reviewActionId, reviewActionReviews } from '@pinpawo/agent-session';
import { ReviewResolutionLifecycle } from './reviewResolutionLifecycle';
import type { AgentSession } from '@pinpawo/agent-session';
import {
  applySessionSnapshot,
  reduceSession,
  type AgentSessionInput,
} from '@pinpawo/agent-session';
import { createAgentSessionSnapshot } from '@pinpawo/agent-session';
import { ThreadInvocationCoordinator } from './threadInvocationCoordinator';

type InflightRequest = InflightOperationRun;
type LoadContext = (actorId: string) => Promise<AgentContext>;
type RunChatSession = typeof runChatSession;
type BuildChatSetup = typeof buildLocalChatAgentInput;
type AppChatRunRequest = ChatSessionRequest;
type AppChatRunSource =
  | { type: 'chat_request' }
  | HumanReviewResolutionSource;
type RunStudioRequest = (ws: WebSocket, message: StudioRequestMessage) => Promise<void>;
type RouteStudioReviewResponse = (ws: WebSocket, message: HumanReviewResponseMessage) => boolean;
type ReviewActionRoute = HumanReviewActionRoute & {
  requestId: string;
  userId: string;
  rejectOptionId?: string;
};
const MAX_HOSTED_SESSION_PROJECTIONS = 100;

export type LocalAgentAppChatHandlerOptions = {
  graphService: LocalAgentGraphService;
  checkpoint: BaseCheckpointSaver;
  deleteThread: (threadId: string) => Promise<void>;
  inflightRequests: InflightRequestController<WebSocket>;
  isCurrentSocket: (ws: WebSocket) => boolean;
  getActorId: () => string;
  getLlmConfig: () => AgentLlmConfig | null;
  getPluginToolkitDefinitions?: () => AgentToolkit[];
  getPluginToolkits: () => AgentToolkit[];
  getLocalToolkitDefinitions?: () => AgentToolkit[];
  getLocalToolkits: () => AgentToolkit[];
  getLocalCapabilities: () => AgentCapability[];
  getUserCapabilities: () => LoadedUserCapability[];
  getCapabilityArtifactStore: () => CapabilityArtifactStore;
  getWorkdir: () => string;
  getActorName: () => string | null;
  runStudioRequest: RunStudioRequest;
  routeStudioHumanReviewResponse: RouteStudioReviewResponse;
  rejectStudioPendingReview: (ws: WebSocket) => void;
  loadContext?: LoadContext;
  runChat?: RunChatSession;
  buildChatSetup?: BuildChatSetup;
  now?: () => number;
  maxSessionProjections?: number;
};

export class LocalAgentAppChatHandler {
  private readonly graphService: LocalAgentGraphService;
  private readonly checkpoint: BaseCheckpointSaver;
  private readonly deleteThread: (threadId: string) => Promise<void>;
  private readonly inflightRequests: InflightRequestController<WebSocket>;
  private readonly isCurrentSocket: (ws: WebSocket) => boolean;
  private readonly getActorId: () => string;
  private readonly getLlmConfig: () => AgentLlmConfig | null;
  private readonly getPluginToolkitDefinitions: () => AgentToolkit[];
  private readonly getPluginToolkits: () => AgentToolkit[];
  private readonly getLocalToolkitDefinitions: () => AgentToolkit[];
  private readonly getLocalToolkits: () => AgentToolkit[];
  private readonly getLocalCapabilities: () => AgentCapability[];
  private readonly getUserCapabilities: () => LoadedUserCapability[];
  private readonly getCapabilityArtifactStore: () => CapabilityArtifactStore;
  private readonly getWorkdir: () => string;
  private readonly getActorName: () => string | null;
  private readonly runStudioRequest: RunStudioRequest;
  private readonly routeStudioHumanReviewResponse: RouteStudioReviewResponse;
  private readonly rejectStudioPendingReview: (ws: WebSocket) => void;
  private readonly loadContext: LoadContext;
  private readonly runChat: RunChatSession;
  private readonly buildChatSetup: BuildChatSetup;
  private readonly now: () => number;
  private readonly maxSessionProjections: number;
  private readonly reviewResolutions = new ReviewResolutionLifecycle<ReviewActionRoute>();
  private readonly reportCapabilityDiagnostics = createCapabilityDiagnosticReporter();
  private readonly threadInvocations = new ThreadInvocationCoordinator();
  private readonly sessionStartedAtByThreadId = new Map<string, string>();
  private readonly sessionsByThreadId = new Map<string, AgentSession>();
  private sessionResetPromise: Promise<void> = Promise.resolve();

  constructor(options: LocalAgentAppChatHandlerOptions) {
    this.graphService = options.graphService;
    this.checkpoint = options.checkpoint;
    this.deleteThread = options.deleteThread;
    this.inflightRequests = options.inflightRequests;
    this.isCurrentSocket = options.isCurrentSocket;
    this.getActorId = options.getActorId;
    this.getLlmConfig = options.getLlmConfig;
    this.getPluginToolkitDefinitions = options.getPluginToolkitDefinitions ?? (() => []);
    this.getPluginToolkits = options.getPluginToolkits;
    this.getLocalToolkitDefinitions = options.getLocalToolkitDefinitions ?? (() => []);
    this.getLocalToolkits = options.getLocalToolkits;
    this.getLocalCapabilities = options.getLocalCapabilities;
    this.getUserCapabilities = options.getUserCapabilities;
    this.getCapabilityArtifactStore = options.getCapabilityArtifactStore;
    this.getWorkdir = options.getWorkdir;
    this.getActorName = options.getActorName;
    this.runStudioRequest = options.runStudioRequest;
    this.routeStudioHumanReviewResponse = options.routeStudioHumanReviewResponse;
    this.rejectStudioPendingReview = options.rejectStudioPendingReview;
    this.loadContext = options.loadContext ?? loadAgentContext;
    this.runChat = options.runChat ?? runChatSession;
    this.buildChatSetup = options.buildChatSetup ?? buildLocalChatAgentInput;
    this.now = options.now ?? Date.now;
    this.maxSessionProjections = Math.max(
      1,
      options.maxSessionProjections ?? MAX_HOSTED_SESSION_PROJECTIONS,
    );
  }

  readSessionProjection(userId: string) {
    return this.sessionsByThreadId.get(this.getChatThreadId(userId)) ?? null;
  }

  handleNewSession(msg: NewSessionMessage) {
    this.sessionResetPromise = this.resetSession(msg).catch((err) => {
      console.error('[local-agent] new_session error:', err instanceof Error ? err.message : err);
    });
    return this.sessionResetPromise;
  }

  handleRunInterrupt(ws: WebSocket, msg: RunInterruptMessage) {
    if (!this.canUseSocket(ws)) {
      return;
    }
    const run = this.inflightRequests.interrupt(ws, { requestId: msg.requestId });
    if (run) {
      this.reduceSessionForRequest(msg.requestId, {
        type: 'run.interrupting',
        requestId: msg.requestId,
      });
    } else {
      this.reviewResolutions.queueInterrupt(msg.requestId);
    }
  }

  async handleReviewCancel(ws: WebSocket, msg: ReviewCancelMessage) {
    if (!this.canUseSocket(ws)) {
      return;
    }
    await this.resolveReviewAction(ws, msg);
  }

  async handleHumanReviewResponse(ws: WebSocket, msg: HumanReviewResponseMessage) {
    if (this.routeStudioHumanReviewResponse(ws, msg)) {
      return;
    }
    if (!this.canUseSocket(ws)) {
      return;
    }
    await this.resolveReviewAction(ws, msg);
  }

  private async resolveReviewAction(
    ws: WebSocket,
    msg: HumanReviewResponseMessage | ReviewCancelMessage,
  ) {
    await resolveHumanReviewAction({
      lifecycle: this.reviewResolutions,
      message: msg,
      recover: () => this.recoverReviewActionRoute({
        requestId: msg.requestId,
        actionId: msg.actionId,
        ...(msg.type === 'human_review_response' ? { reviewId: msg.reviewId } : {}),
      }),
      emitClosed: () => this.sendClosedReviewError(ws, msg.requestId),
      emitEvent: (event) => sendLocalAgentEvent(ws, event),
      isConnected: () => this.canUseSocket(ws),
      run: (route, resume, source) => this.runChatRequest(ws, {
        kind: 'resume',
        requestId: msg.requestId,
        resume,
      }, route.userId, source),
    });
  }

  handleClose(ws: WebSocket) {
    this.rejectStudioPendingReview(ws);
    this.inflightRequests.abortAll(ws);
  }

  async handleStudioRequest(ws: WebSocket, msg: StudioRequestMessage) {
    if (!this.canUseSocket(ws)) {
      return;
    }
    await this.runStudioRequest(ws, msg);
  }

  async handleChatRequest(ws: WebSocket, msg: ChatRequestMessage) {
    const { requestId, message } = msg;
    if (!this.canUseSocket(ws)) return;

    const userId = msg.userId?.trim();
    if (!userId) {
      sendLocalAgentEvent(ws, {
        type: 'error',
        requestId,
        message: 'userId is required',
      });
      return;
    }

    await this.sessionResetPromise;
    if (!this.canUseSocket(ws)) return;

    await this.runChatRequest(ws, {
      kind: 'user_message',
      requestId,
      message,
      ...(msg.activeDelegationTransition
        ? { activeDelegationTransition: msg.activeDelegationTransition }
        : {}),
    }, userId, { type: 'chat_request' });
  }

  private async runChatRequest(
    ws: WebSocket,
    request: AppChatRunRequest,
    userId: string,
    source: AppChatRunSource,
  ): Promise<HumanReviewResolutionOutcome> {
    const { requestId } = request;
    const message = request.kind === 'user_message' ? request.message : '';

    if (source.type === 'chat_request') {
      console.log(`[local-agent] chat_request requestId=${requestId} message="${message.slice(0, 80)}"`);
    } else if (source.type === 'human_review_response') {
      console.log(
        `[local-agent] human_review_response requestId=${requestId} `
        + `reviewId=${source.reviewId} option=${source.selectedOptionId}`
        + (source.decisionCount ? ` decisions=${source.decisionCount}` : ''),
      );
    } else {
      console.log(
        `[local-agent] review.cancel resume human_review requestId=${requestId} `
        + `reviewId=${source.reviewId} action=interrupt_run`,
      );
    }
    const threadId = this.getChatThreadId(userId);
    const inflight = this.inflightRequests.start(ws, requestId, {
      observeOperation: (event) => {
        this.projectRemoteEvent(userId, event);
      },
    });
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
      this.inflightRequests.sendInterrupted(ws, inflight);
      this.finishRemoteRun(userId, requestId);
      this.inflightRequests.clear(ws, inflight);
    };

    try {
      await invocation.waitForTurn();
      recordAgentRunActivity('thinking', requestId);
      if (request.kind === 'user_message') {
        this.reduceRemoteSession(userId, {
          type: 'user.accepted',
          requestId,
          kind: 'chat',
          text: message,
          message: { id: `message:${requestId}:user` },
        });
      }
      const ctx = await this.loadContext(this.getActorId());
      if (!isCurrent()) {
        finishInterrupted();
        return 'interrupted';
      }

      const setup = this.buildSetup(ctx, message, userId);
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
          this.emitRemoteEvent(ws, userId, event);
        },
        emitToolEvent: (event) => {
          if (!isCurrent()) return;
          this.sendStreamToolOperationEvent(ws, inflight, event, userId);
        },
        acceptDelegationOperations: (operations) => {
          if (!isCurrent()) return;
          overlayInflightDelegationOperations(inflight, operations);
        },
        ...(source.type === 'review.cancel'
          ? { interruptOnSettledResumeCheckpoint: true }
          : {}),
        ...(source.type !== 'chat_request'
          ? {
            onResumeCheckpointed: ({ canInterrupt }: { canInterrupt: boolean }) => {
              const interruptQueued = this.reviewResolutions.checkpoint(requestId);
              if (!canInterrupt || !interruptQueued) {
                return;
              }
              const interrupted = this.inflightRequests.interrupt(ws, { requestId });
              if (interrupted) {
                this.reduceSessionForRequest(requestId, {
                  type: 'run.interrupting',
                  requestId,
                });
              }
            },
          }
          : {}),
      });
      if (result.status === 'waiting_human') {
        this.inflightRequests.finish(ws, inflight, 'interrupted');
        console.log(`[local-agent] human_review.requested requestId=${requestId}`);
        this.inflightRequests.clear(ws, inflight);
        return 'waiting_human';
      }
      if (result.status === 'interrupted') {
        finishInterrupted();
        return 'interrupted';
      }
      this.inflightRequests.finish(ws, inflight, 'completed');
      this.inflightRequests.clear(ws, inflight);
      this.finishRemoteRun(userId, requestId);

      console.log(`[local-agent] message.completed sent requestId=${requestId} reply="${result.reply.slice(0, 100)}"`);
      return 'completed';
    } catch (err) {
      const isStillCurrent = isCurrent();
      const aborted = controller.signal.aborted
        || (err instanceof Error && err.name === 'AbortError');
      if (aborted) {
        console.warn(`[local-agent] chat interrupted requestId=${requestId}`);
        this.inflightRequests.sendInterrupted(ws, inflight);
        this.finishRemoteRun(userId, requestId);
        recordAgentRunActivity('interrupted', requestId, 2_500);
        this.inflightRequests.clear(ws, inflight);
        return 'interrupted';
      }
      this.inflightRequests.finish(ws, inflight, 'failed', err);
      this.inflightRequests.clear(ws, inflight);
      recordAgentRunActivity('error', requestId, 5_000);
      console.error('[local-agent] chat error:', err instanceof Error ? err.message : err);
      if (isStillCurrent && ws.readyState === WebSocket.OPEN) {
        this.emitRemoteEvent(ws, userId, {
          type: 'error',
          requestId,
          message: 'internal error',
        });
      }
      return 'failed';
    } finally {
      invocation.settle();
    }
  }

  private async resetSession(msg: NewSessionMessage) {
    const userId = msg.userId?.trim();
    if (!userId) {
      return;
    }

    const threadId = this.getChatThreadId(userId);
    await this.deleteThread(threadId);
    this.sessionStartedAtByThreadId.delete(threadId);
    this.sessionsByThreadId.delete(threadId);
    this.clearReviewActionRoutesForUser(userId);
    console.log(`[local-agent] new session created threadId=${threadId}`);
  }

  private buildReviewActionRoute(
    requestId: string,
    review: ReviewSpec,
    userId: string,
    reviews?: ReviewSpec[],
    interruptId?: string,
  ): ReviewActionRoute {
    const actionReviews = reviewActionReviews(review, reviews);
    const rejectOption = actionReviews[0]?.options.find((option) => option.decision.type === 'reject');
    return {
      requestId,
      userId,
      ...(interruptId ? { interruptId } : {}),
      actionId: reviewActionId({
        requestId,
        ...(interruptId ? { interruptId } : {}),
        reviews: actionReviews,
      }),
      ...(rejectOption ? { rejectOptionId: rejectOption.id } : {}),
      reviews: actionReviews,
    };
  }

  private recordReviewActionRoute(event: AgentRuntimeEvent, userId: string) {
    if (event.type !== 'human_review.requested' || !event.review?.id) {
      return;
    }
    this.reviewResolutions.register(
      this.buildReviewActionRoute(
        event.requestId,
        event.review,
        userId,
        event.reviews,
        event.interruptId,
      ),
      { observedPending: true },
    );
  }

  private async recoverReviewActionRoute(params: {
    requestId: string;
    actionId?: string;
    reviewId?: string;
  }) {
    try {
      const userIds = await this.readCheckpointAppChatUserIds();
      if (userIds.length === 0) return null;
      const context = await this.loadContext(this.getActorId());
      const candidates: ReviewActionRoute[] = [];
      let incompleteScan = false;
      for (const userId of userIds) {
        try {
          const setup = this.buildSetup(context, '', userId);
          const state = await this.graphService.readThreadState(setup);
          const pending = state.pendingHumanReview;
          if (!pending) continue;
          const route = this.buildReviewActionRoute(
            params.requestId,
            pending.review,
            userId,
            pending.reviews,
            pending.interruptId,
          );
          const matches = params.actionId
            ? route.actionId === params.actionId
            : Boolean(
              params.reviewId
              && route.reviews.some((review) => review.id === params.reviewId),
            );
          if (matches) {
            candidates.push(route);
          }
        } catch (err) {
          incompleteScan = true;
          console.warn(
            `[local-agent-app] failed to inspect pending review userId=${userId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      if (incompleteScan && !params.actionId) {
        console.warn(
          `[local-agent-app] legacy pending review recovery is incomplete requestId=${params.requestId}`,
        );
        return null;
      }
      if (candidates.length !== 1) {
        if (candidates.length > 1) {
          console.warn(
            `[local-agent-app] pending review recovery is ambiguous requestId=${params.requestId} `
            + `matches=${candidates.length}`,
          );
        }
        return null;
      }
      const route = candidates[0]!;
      this.reconcilePendingReviewSession(params.requestId, route);
      return route;
    } catch (err) {
      console.warn(
        '[local-agent-app] failed to recover pending human_review from checkpoint:',
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  private async readCheckpointAppChatUserIds() {
    const actorId = this.getActorId();
    const prefix = `petbot:chat:pet:${actorId}:user:`;
    const userIds = new Set<string>();
    for await (const tuple of this.checkpoint.list({ configurable: {} })) {
      const threadId = tuple.config.configurable?.thread_id;
      if (typeof threadId !== 'string' || !threadId.startsWith(prefix)) continue;
      const userId = threadId.slice(prefix.length).trim();
      if (userId) userIds.add(userId);
    }
    return [...userIds];
  }

  private createRemoteSession(userId: string): AgentSession {
    const llmConfig = this.getLlmConfig();
    return {
      sessionId: this.getChatThreadId(userId),
      kind: 'chat',
      timeline: [],
      activeRun: null,
      runtime: {
        cwd: this.getWorkdir(),
        ...(llmConfig?.model ? { model: llmConfig.model } : {}),
      },
    };
  }

  private reduceRemoteSession(userId: string, input: AgentSessionInput) {
    return this.applyRemoteSessionInput(userId, input).session;
  }

  private applyRemoteSessionInput(userId: string, input: AgentSessionInput) {
    const threadId = this.getChatThreadId(userId);
    const session = this.sessionsByThreadId.get(threadId) ?? this.createRemoteSession(userId);
    const nextSession = reduceSession(session, input, { observedAt: this.now() });
    this.storeRemoteSession(threadId, nextSession);
    return { session: nextSession, changed: nextSession !== session };
  }

  private storeRemoteSession(threadId: string, session: AgentSession) {
    this.sessionsByThreadId.delete(threadId);
    this.sessionsByThreadId.set(threadId, session);
    while (this.sessionsByThreadId.size > this.maxSessionProjections) {
      const oldestThreadId = [...this.sessionsByThreadId.entries()].find(
        ([, candidate]) => candidate.activeRun === null,
      )?.[0];
      if (!oldestThreadId) break;
      this.sessionsByThreadId.delete(oldestThreadId);
    }
  }

  private reduceSessionForRequest(requestId: string, input: AgentSessionInput) {
    for (const [threadId, session] of this.sessionsByThreadId) {
      if (session.activeRun?.requestId !== requestId) continue;
      this.storeRemoteSession(threadId, reduceSession(session, input, { observedAt: this.now() }));
      return;
    }
  }

  private finishRemoteRun(userId: string, requestId: string) {
    this.reduceRemoteSession(userId, { type: 'run.finished', requestId });
  }

  private emitRemoteEvent(ws: WebSocket, userId: string, event: AgentRuntimeEvent) {
    const remoteEvent = redactRemoteCompletedMessagePaths(event);
    if (!this.projectRemoteEvent(userId, remoteEvent)) {
      return false;
    }
    this.recordReviewActionRoute(remoteEvent, userId);
    return sendLocalAgentEvent(ws, remoteEvent);
  }

  private projectRemoteEvent(userId: string, event: AgentRuntimeEvent) {
    return this.applyRemoteSessionInput(userId, { type: 'runtime.event', event }).changed;
  }

  private reconcilePendingReviewSession(requestId: string, route: ReviewActionRoute) {
    const threadId = this.getChatThreadId(route.userId);
    const session = this.sessionsByThreadId.get(threadId) ?? this.createRemoteSession(route.userId);
    const snapshot = createAgentSessionSnapshot({
      ...session,
      activeRun: {
        requestId,
        state: 'waiting_review' as const,
        reviewAction: {
          actionId: route.actionId,
          reviews: route.reviews,
        },
      },
    });
    this.storeRemoteSession(
      threadId,
      applySessionSnapshot(session, snapshot, {
        observedAt: this.now(),
        preserveOmittedTokenUsage: true,
      }),
    );
  }

  private clearReviewActionRoutesForUser(userId: string) {
    this.reviewResolutions.removeRoutes((route) => route.userId === userId);
  }

  private sendClosedReviewError(ws: WebSocket, requestId: string) {
    sendLocalAgentEvent(ws, {
      type: 'error',
      requestId,
      message: '这个 review 已关闭或不存在，请等待当前确认面板刷新后再应答。',
    });
  }

  private buildSetup(ctx: AgentContext, userMessage: string, userId: string): AgentChannelSetup {
    const threadId = this.getChatThreadId(userId);
    return this.buildChatSetup({
      context: ctx,
      userMessage,
      llmConfig: this.getLlmConfig() ?? buildLocalLlmConfig(),
      toolkits: [...this.getPluginToolkits(), ...this.getLocalToolkits()],
      toolkitDefinitions: [
        ...this.getPluginToolkitDefinitions(),
        ...this.getLocalToolkitDefinitions(),
      ],
      reportCapabilityDiagnostics: this.reportCapabilityDiagnostics,
      extraCapabilities: this.getLocalCapabilities(),
      threadId,
      interfaceKind: 'app-chat',
      dryRun: false,
      checkpoint: this.checkpoint,
      userCapabilities: this.getUserCapabilities(),
      capabilityArtifactStore: this.getCapabilityArtifactStore(),
      workdir: this.getWorkdir(),
      sessionStartedAt: this.getSessionStartedAt(threadId),
    });
  }

  private getChatThreadId(userId: string) {
    return buildAppChatThreadId({ petId: this.getActorId(), userId });
  }

  private getSessionStartedAt(threadId: string) {
    const existing = this.sessionStartedAtByThreadId.get(threadId);
    if (existing) return existing;
    const sessionStartedAt = new Date().toISOString();
    this.sessionStartedAtByThreadId.set(threadId, sessionStartedAt);
    return sessionStartedAt;
  }

  private canUseSocket(ws: WebSocket) {
    return this.isCurrentSocket(ws) && ws.readyState === WebSocket.OPEN;
  }

  private sendStreamToolOperationEvent(
    ws: WebSocket,
    inflight: InflightRequest,
    payload: StreamToolsPayload,
    userId: string,
  ) {
    // Hosted app relay: strip raw (default). Remote UI must derive its view
    // from operation.summary/details — see docs/local-agent-events.md.
    emitInflightToolEvent(inflight, payload, (event) => this.emitRemoteEvent(ws, userId, event));
  }
}
