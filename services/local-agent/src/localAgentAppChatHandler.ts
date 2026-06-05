import { WebSocket } from 'ws';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { StructuredTool } from '@langchain/core/tools';
import type { AgentCapability, AgentToolkit } from '@pinpawo/pet-agent';
import { buildLocalChatAgentInput, type AgentChannelSetup } from './agentChannel';
import { loadAgentContext, type AgentContext } from './contextLoader';
import { buildLocalLlmConfig } from './llmConfig';
import type { AgentLlmConfig } from './agentConfig';
import type { LoadedUserCapability } from './capabilityLoader';
import { buildAppChatThreadId } from './chatInterface';
import {
  sendLocalAgentEvent,
  type ChatRequestMessage,
  type InterruptRequestMessage,
  type NewSessionMessage,
} from './localAgentProtocol';
import { recordAgentRunActivity } from './operationActivityState';
import type { StreamToolsPayload } from './agentStreamEvents';
import { runChatSession } from './chatSessionAdapter';
import type { LocalAgentGraphService } from './agentGraphService';
import {
  configureInflightOperationRegistry,
  emitInflightToolEvent,
  type InflightOperationRun,
} from './inflightOperationRun';
import { InflightRequestController } from './inflightRequestController';
import { createOperationRegistryForAgentSetup } from './runtimeOperationRegistry';

type InflightRequest = InflightOperationRun;
type LoadContext = (actorId: string) => Promise<AgentContext>;
type RunChatSession = typeof runChatSession;
type BuildChatSetup = typeof buildLocalChatAgentInput;

export type LocalAgentAppChatHandlerOptions = {
  graphService: LocalAgentGraphService;
  checkpoint: BaseCheckpointSaver;
  deleteThread: (threadId: string) => Promise<void>;
  inflightRequests: InflightRequestController<WebSocket>;
  isCurrentSocket: (ws: WebSocket) => boolean;
  getActorId: () => string;
  getLlmConfig: () => AgentLlmConfig | null;
  /** Deprecated raw plugin tools fallback. New plugins should export toolkits. */
  getLegacyPluginTools: () => StructuredTool[];
  getPluginToolkits: () => AgentToolkit[];
  getLocalToolkits: () => AgentToolkit[];
  getLocalCapabilities: () => AgentCapability[];
  getUserCapabilities: () => LoadedUserCapability[];
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
  private readonly getLegacyPluginTools: () => StructuredTool[];
  private readonly getPluginToolkits: () => AgentToolkit[];
  private readonly getLocalToolkits: () => AgentToolkit[];
  private readonly getLocalCapabilities: () => AgentCapability[];
  private readonly getUserCapabilities: () => LoadedUserCapability[];
  private readonly loadContext: LoadContext;
  private readonly runChat: RunChatSession;
  private readonly buildChatSetup: BuildChatSetup;
  private sessionResetPromise: Promise<void> = Promise.resolve();

  constructor(options: LocalAgentAppChatHandlerOptions) {
    this.graphService = options.graphService;
    this.checkpoint = options.checkpoint;
    this.deleteThread = options.deleteThread;
    this.inflightRequests = options.inflightRequests;
    this.isCurrentSocket = options.isCurrentSocket;
    this.getActorId = options.getActorId;
    this.getLlmConfig = options.getLlmConfig;
    this.getLegacyPluginTools = options.getLegacyPluginTools;
    this.getPluginToolkits = options.getPluginToolkits;
    this.getLocalToolkits = options.getLocalToolkits;
    this.getLocalCapabilities = options.getLocalCapabilities;
    this.getUserCapabilities = options.getUserCapabilities;
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

  handleInterruptRequest(ws: WebSocket, msg: InterruptRequestMessage) {
    if (!this.canUseSocket(ws)) {
      return;
    }
    this.inflightRequests.interrupt(ws, { requestId: msg.requestId });
  }

  handleClose(ws: WebSocket) {
    this.inflightRequests.abortAndClear(ws);
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

    console.log(`[local-agent] chat_request requestId=${requestId} message="${message.slice(0, 80)}"`);
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
        request: msg,
        setup,
        graphService: this.graphService,
        isCurrent,
        finishInterrupted,
        emitEvent: (event) => {
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
    console.log(`[local-agent] new session created threadId=${threadId}`);
  }

  private buildSetup(ctx: AgentContext, userMessage: string, userId: string): AgentChannelSetup {
    return this.buildChatSetup({
      context: ctx,
      userMessage,
      llmConfig: this.getLlmConfig() ?? buildLocalLlmConfig(),
      legacyDirectTools: this.getLegacyPluginTools(),
      toolkits: [...this.getPluginToolkits(), ...this.getLocalToolkits()],
      extraCapabilities: this.getLocalCapabilities(),
      threadId: this.getChatThreadId(userId),
      interfaceKind: 'app-chat',
      dryRun: false,
      checkpoint: this.checkpoint,
      userCapabilities: this.getUserCapabilities(),
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
    emitInflightToolEvent(inflight, payload, (event) => sendLocalAgentEvent(ws, event));
  }
}
