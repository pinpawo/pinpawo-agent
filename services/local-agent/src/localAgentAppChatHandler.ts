import { WebSocket } from 'ws';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { AgentCapability, AgentToolkit, CapabilityArtifactStore, ReviewSpec } from '@pinpawo/pet-agent';
import { buildLocalChatAgentInput, type AgentChannelSetup } from './agentChannel';
import { loadAgentContext, type AgentContext } from './contextLoader';
import { buildLocalLlmConfig } from './llmConfig';
import type { AgentLlmConfig } from './agentConfig';
import type { LoadedUserCapability } from './capabilityLoader';
import { buildAppChatThreadId } from './chatInterface';
import {
  sendLocalAgentEvent,
  type ChatRequestMessage,
  type HumanReviewResponseMessage,
  type InterruptRequestMessage,
  type NewSessionMessage,
  type StudioRequestMessage,
} from './localAgentProtocol';
import { recordAgentRunActivity } from './operationActivityState';
import type { StreamToolsPayload } from './agentStreamEvents';
import { runChatSession, type ChatSessionRequest } from './chatSessionAdapter';
import type { LocalAgentGraphService } from './agentGraphService';
import {
  configureInflightOperationRegistry,
  emitInflightToolEvent,
  type InflightOperationRun,
} from './inflightOperationRun';
import { InflightRequestController } from './inflightRequestController';
import { createOperationRegistryForAgentSetup } from './runtimeOperationRegistry';
import type { LocalAgentEvent } from './events/localAgentEvent';

type InflightRequest = InflightOperationRun;
type LoadContext = (actorId: string) => Promise<AgentContext>;
type RunChatSession = typeof runChatSession;
type BuildChatSetup = typeof buildLocalChatAgentInput;
type AppChatRunRequest = ChatSessionRequest;
type AppChatRunSource =
  | { type: 'chat_request' }
  | { type: 'human_review_response'; reviewId: string; selectedOptionId: string }
  | { type: 'interrupt_request'; reviewId: string; selectedOptionId: string };
type RunStudioRequest = (ws: WebSocket, message: StudioRequestMessage) => Promise<void>;
type RouteStudioReviewResponse = (ws: WebSocket, message: HumanReviewResponseMessage) => boolean;
type PendingReviewRoute = {
  userId: string;
  reviewId: string;
  rejectOptionId?: string;
  review: ReviewSpec;
};

const MAX_CONSUMED_PENDING_REVIEW_REQUEST_IDS = 1000;

export type LocalAgentAppChatHandlerOptions = {
  graphService: LocalAgentGraphService;
  checkpoint: BaseCheckpointSaver;
  deleteThread: (threadId: string) => Promise<void>;
  inflightRequests: InflightRequestController<WebSocket>;
  isCurrentSocket: (ws: WebSocket) => boolean;
  getActorId: () => string;
  getLlmConfig: () => AgentLlmConfig | null;
  getPluginToolkits: () => AgentToolkit[];
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
};

export class LocalAgentAppChatHandler {
  private readonly graphService: LocalAgentGraphService;
  private readonly checkpoint: BaseCheckpointSaver;
  private readonly deleteThread: (threadId: string) => Promise<void>;
  private readonly inflightRequests: InflightRequestController<WebSocket>;
  private readonly isCurrentSocket: (ws: WebSocket) => boolean;
  private readonly getActorId: () => string;
  private readonly getLlmConfig: () => AgentLlmConfig | null;
  private readonly getPluginToolkits: () => AgentToolkit[];
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
  private readonly pendingReviewRoutes = new Map<string, PendingReviewRoute>();
  private readonly consumedPendingReviewRequestIds = new Set<string>();
  private readonly activePendingReviewRequestIds = new Set<string>();
  private sessionResetPromise: Promise<void> = Promise.resolve();

  constructor(options: LocalAgentAppChatHandlerOptions) {
    this.graphService = options.graphService;
    this.checkpoint = options.checkpoint;
    this.deleteThread = options.deleteThread;
    this.inflightRequests = options.inflightRequests;
    this.isCurrentSocket = options.isCurrentSocket;
    this.getActorId = options.getActorId;
    this.getLlmConfig = options.getLlmConfig;
    this.getPluginToolkits = options.getPluginToolkits;
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
  }

  handleNewSession(msg: NewSessionMessage) {
    this.sessionResetPromise = this.resetSession(msg).catch((err) => {
      console.error('[local-agent] new_session error:', err instanceof Error ? err.message : err);
    });
    return this.sessionResetPromise;
  }

  async handleInterruptRequest(ws: WebSocket, msg: InterruptRequestMessage) {
    if (!this.canUseSocket(ws)) {
      return;
    }
    const route = this.readPendingReviewRoute(msg.requestId);
    if (route) {
      await this.handlePendingReviewInterrupt(ws, msg, route);
      return;
    }
    this.inflightRequests.interrupt(ws, { requestId: msg.requestId });
  }

  async handleHumanReviewResponse(ws: WebSocket, msg: HumanReviewResponseMessage) {
    if (this.routeStudioHumanReviewResponse(ws, msg)) {
      return;
    }
    if (!this.canUseSocket(ws)) {
      return;
    }
    if (!this.claimPendingReviewRequest(msg.requestId)) {
      this.sendClosedReviewError(ws, msg.requestId);
      return;
    }
    const route = this.readPendingReviewRoute(msg.requestId);
    if (!route) {
      this.releasePendingReviewRequest(msg.requestId);
      this.sendClosedReviewError(ws, msg.requestId);
      return;
    }
    if (msg.reviewId !== route.reviewId) {
      this.releasePendingReviewRequest(msg.requestId);
      sendLocalAgentEvent(ws, {
        type: 'error',
        requestId: msg.requestId,
        message: '这个 review 已经过期，请等待当前确认面板刷新后再应答。',
      });
      return;
    }

    this.consumePendingReviewRoute(msg.requestId);
    await this.runChatRequest(ws, {
      kind: 'resume',
      requestId: msg.requestId,
      resume: {
        reviewId: msg.reviewId,
        selectedOptionId: msg.selectedOptionId,
        ...(msg.input ? { input: msg.input } : {}),
      },
    }, route.userId, {
      type: 'human_review_response',
      reviewId: msg.reviewId,
      selectedOptionId: msg.selectedOptionId,
    });
  }

  handleClose(ws: WebSocket) {
    this.rejectStudioPendingReview(ws);
    this.inflightRequests.abortAndClear(ws);
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
    }, userId, { type: 'chat_request' });
  }

  private async handlePendingReviewInterrupt(
    ws: WebSocket,
    msg: InterruptRequestMessage,
    route: PendingReviewRoute,
  ) {
    if (!this.claimPendingReviewRequest(msg.requestId)) {
      return;
    }
    if (!route.rejectOptionId) {
      this.releasePendingReviewRequest(msg.requestId);
      sendLocalAgentEvent(ws, {
        type: 'system.notice',
        requestId: msg.requestId,
        message: '当前 review 没有可用的拒绝选项，无法自动取消。',
      });
      sendLocalAgentEvent(ws, {
        type: 'human_review.requested',
        requestId: msg.requestId,
        review: route.review,
      });
      return;
    }

    this.consumePendingReviewRoute(msg.requestId);
    await this.runChatRequest(ws, {
      kind: 'resume',
      requestId: msg.requestId,
      resume: {
        reviewId: route.reviewId,
        selectedOptionId: route.rejectOptionId,
      },
    }, route.userId, {
      type: 'interrupt_request',
      reviewId: route.reviewId,
      selectedOptionId: route.rejectOptionId,
    });
  }

  private async runChatRequest(
    ws: WebSocket,
    request: AppChatRunRequest,
    userId: string,
    source: AppChatRunSource,
  ) {
    const { requestId } = request;
    const message = request.kind === 'user_message' ? request.message : '';

    if (source.type === 'chat_request') {
      console.log(`[local-agent] chat_request requestId=${requestId} message="${message.slice(0, 80)}"`);
    } else if (source.type === 'human_review_response') {
      console.log(
        `[local-agent] human_review_response requestId=${requestId} `
        + `reviewId=${source.reviewId} option=${source.selectedOptionId}`,
      );
    } else {
      console.log(
        `[local-agent] interrupt_request resume human_review requestId=${requestId} `
        + `reviewId=${source.reviewId} option=${source.selectedOptionId}`,
      );
    }
    recordAgentRunActivity('thinking', requestId);

    const inflight = this.inflightRequests.start(ws, requestId, {
      interruptPrevious: true,
      notifyPrevious: false,
    });
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
      const ctx = await this.loadContext(this.getActorId());
      if (!isCurrent()) {
        finishInterrupted();
        return;
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
          this.recordPendingReviewRoute(event, userId);
          sendLocalAgentEvent(ws, event);
        },
        emitToolEvent: (event) => {
          this.sendStreamToolOperationEvent(ws, inflight, event);
        },
      });
      if (result.status === 'waiting_human') {
        this.inflightRequests.finish(ws, inflight, 'interrupted');
        console.log(`[local-agent] human_review.requested requestId=${requestId}`);
        this.inflightRequests.clear(ws, inflight);
        return;
      }
      if (result.status === 'interrupted') {
        return;
      }
      this.inflightRequests.finish(ws, inflight, 'completed');
      this.inflightRequests.clear(ws, inflight);

      console.log(`[local-agent] message.completed sent requestId=${requestId} reply="${result.reply.slice(0, 100)}"`);
    } catch (err) {
      const isStillCurrent = this.inflightRequests.isCurrent(ws, inflight);
      const aborted = controller.signal.aborted
        || (err instanceof Error && err.name === 'AbortError');
      if (aborted) {
        console.warn(`[local-agent] chat interrupted requestId=${requestId}`);
        this.inflightRequests.sendInterrupted(ws, inflight);
        recordAgentRunActivity('interrupted', requestId, 2_500);
        this.inflightRequests.clear(ws, inflight);
        return;
      }
      this.inflightRequests.finish(ws, inflight, 'failed', err);
      this.inflightRequests.clear(ws, inflight);
      recordAgentRunActivity('error', requestId, 5_000);
      console.error('[local-agent] chat error:', err instanceof Error ? err.message : err);
      if (isStillCurrent && ws.readyState === WebSocket.OPEN) {
        sendLocalAgentEvent(ws, {
          type: 'error',
          requestId,
          message: err instanceof Error ? err.message : 'internal error',
        });
      }
    }
  }

  private async resetSession(msg: NewSessionMessage) {
    const userId = msg.userId?.trim();
    if (!userId) {
      return;
    }

    const threadId = this.getChatThreadId(userId);
    await this.deleteThread(threadId);
    this.clearPendingReviewRoutesForUser(userId);
    console.log(`[local-agent] new session created threadId=${threadId}`);
  }

  private buildPendingReviewRoute(review: ReviewSpec, userId: string): PendingReviewRoute {
    const rejectOption = review.options.find((option) => option.decision.type === 'reject');
    return {
      userId,
      reviewId: review.id,
      ...(rejectOption ? { rejectOptionId: rejectOption.id } : {}),
      review,
    };
  }

  private recordPendingReviewRoute(event: LocalAgentEvent, userId: string) {
    if (event.type !== 'human_review.requested' || !event.review?.id) {
      return;
    }
    this.consumedPendingReviewRequestIds.delete(event.requestId);
    this.activePendingReviewRequestIds.delete(event.requestId);
    this.pendingReviewRoutes.set(
      event.requestId,
      this.buildPendingReviewRoute(event.review, userId),
    );
  }

  private readPendingReviewRoute(requestId: string) {
    if (this.consumedPendingReviewRequestIds.has(requestId)) {
      return null;
    }
    return this.pendingReviewRoutes.get(requestId) ?? null;
  }

  private consumePendingReviewRoute(requestId: string) {
    this.pendingReviewRoutes.delete(requestId);
    this.activePendingReviewRequestIds.delete(requestId);
    this.consumedPendingReviewRequestIds.add(requestId);
    while (this.consumedPendingReviewRequestIds.size > MAX_CONSUMED_PENDING_REVIEW_REQUEST_IDS) {
      const oldest = this.consumedPendingReviewRequestIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.consumedPendingReviewRequestIds.delete(oldest);
    }
  }

  private clearPendingReviewRoutesForUser(userId: string) {
    for (const [requestId, route] of this.pendingReviewRoutes) {
      if (route.userId === userId) {
        this.pendingReviewRoutes.delete(requestId);
        this.activePendingReviewRequestIds.delete(requestId);
        this.consumedPendingReviewRequestIds.delete(requestId);
      }
    }
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

  private sendClosedReviewError(ws: WebSocket, requestId: string) {
    sendLocalAgentEvent(ws, {
      type: 'error',
      requestId,
      message: '这个 review 已关闭或不存在，请等待当前确认面板刷新后再应答。',
    });
  }

  private buildSetup(ctx: AgentContext, userMessage: string, userId: string): AgentChannelSetup {
    return this.buildChatSetup({
      context: ctx,
      userMessage,
      llmConfig: this.getLlmConfig() ?? buildLocalLlmConfig(),
      toolkits: [...this.getPluginToolkits(), ...this.getLocalToolkits()],
      extraCapabilities: this.getLocalCapabilities(),
      threadId: this.getChatThreadId(userId),
      interfaceKind: 'app-chat',
      dryRun: false,
      checkpoint: this.checkpoint,
      userCapabilities: this.getUserCapabilities(),
      capabilityArtifactStore: this.getCapabilityArtifactStore(),
      workdir: this.getWorkdir(),
    });
  }

  private getChatThreadId(userId: string) {
    return buildAppChatThreadId({ petId: this.getActorId(), userId });
  }

  private canUseSocket(ws: WebSocket) {
    return this.isCurrentSocket(ws) && ws.readyState === WebSocket.OPEN;
  }

  private sendStreamToolOperationEvent(
    ws: WebSocket,
    inflight: InflightRequest,
    payload: StreamToolsPayload,
  ) {
    // Hosted app relay: strip raw (default). Remote UI must derive its view
    // from operation.summary/details — see docs/local-agent-events.md.
    emitInflightToolEvent(inflight, payload, (event) => sendLocalAgentEvent(ws, event));
  }
}
