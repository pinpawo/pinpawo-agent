import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { FileSaver } from './fileSaver';
import { config } from './config';
import { loadAgentContext } from './contextLoader';
import {
  type AgentCapability,
  type AgentToolkit,
} from '@pinpawo/pet-agent';
import { FileStudioDueRunStore } from '@pinpawo/pet-agent';
import { collectPluginHooks, loadPlugins } from './pluginLoader';
import type { LoadedUserCapability } from './capabilityLoader';
import type { AgentLlmConfig } from './agentConfig';
import {
  buildLocalLlmConfig,
} from './llmConfig';
import { LocalAgentGraphService } from './agentGraphService';
import { ensureActorSelected, loadSelectedActorName } from './actorSelection';
import { loadStoredConfig, saveStoredConfig } from './storage';
import {
  sendLocalAgentEvent,
  sendLocalAgentMessage,
} from './localAgentProtocol';
import { InflightRequestController } from './inflightRequestController';
import { LocalAgentAppWsClient } from './localAgentAppWsClient';
import { LocalAgentAppChatHandler } from './localAgentAppChatHandler';
import { LocalAgentCapabilityRegistry } from './localAgentCapabilityRegistry';
import { buildLocalAgentRuntimeConfig, type LocalAgentRuntimeConfig } from './runtimeConfig';
import { setLocalToolsWorkdir } from './toolkits/local/pathUtils';
import { LocalServerStudioHandler } from './localServerStudioHandler';
import { LocalServerStudioReviewRouter } from './localServerStudioReviews';
import { LocalStudioDueRunScheduler } from './localStudioDueRunScheduler';
import type { LocalServerDeps } from './localServerTypes';

const WS_RECONNECT_DELAY_MS = 10000;
const WS_PING_INTERVAL_MS = 30000;
const INTERRUPT_FORCE_REPLY_MS = 1800;

export class LocalAgentRuntime {
  private readonly runtimeConfig: LocalAgentRuntimeConfig;
  private stopRequested = false;
  private actorId: string | null = null;
  private actorName: string | null = null;
  private llmConfig: AgentLlmConfig | null = null;
  private hooks: ReturnType<typeof collectPluginHooks> | null = null;
  private pluginToolkits: AgentToolkit[] = [];
  private readonly capabilityRegistry: LocalAgentCapabilityRegistry;
  private readonly chatCheckpointer: FileSaver;
  private readonly studioDueRunStore: FileStudioDueRunStore;
  private readonly studioDueRunScheduler: LocalStudioDueRunScheduler;
  private readonly graphService = new LocalAgentGraphService();
  private readonly inflightRequests = new InflightRequestController<WebSocket>({
    forceInterruptMs: INTERRUPT_FORCE_REPLY_MS,
    // Hosted app WS relay: do NOT include raw — keeps payloads small and
    // avoids leaking raw tool input/output through the remote channel.
    emitOperation: (ws, event) => sendLocalAgentEvent(ws, event),
    sendControl: (ws, message) => sendLocalAgentMessage(ws, message),
    logPrefix: 'local-agent',
  });
  private readonly studioReviewRouter = new LocalServerStudioReviewRouter<WebSocket>();
  private readonly studioHandler: LocalServerStudioHandler;
  private appWsClient: LocalAgentAppWsClient | null = null;
  private readonly appChatHandler: LocalAgentAppChatHandler;

  constructor(runtimeConfig: LocalAgentRuntimeConfig = buildLocalAgentRuntimeConfig()) {
    this.runtimeConfig = runtimeConfig;
    setLocalToolsWorkdir(runtimeConfig.workdir);
    this.capabilityRegistry = new LocalAgentCapabilityRegistry({
      capabilityArtifactRoot: runtimeConfig.capabilityArtifactRoot,
    });
    this.studioDueRunStore = new FileStudioDueRunStore({
      filePath: runtimeConfig.studioDueRunsPath,
    });
    this.studioDueRunScheduler = new LocalStudioDueRunScheduler({
      store: this.studioDueRunStore,
      filterWorkdir: runtimeConfig.workdir,
    });
    this.studioHandler = new LocalServerStudioHandler({
      reviewRouter: this.studioReviewRouter,
      inflightRequests: this.inflightRequests,
      studioDueRunScheduler: this.studioDueRunScheduler,
    });
    this.chatCheckpointer = new FileSaver(runtimeConfig.checkpointPath);
    this.appChatHandler = new LocalAgentAppChatHandler({
      graphService: this.graphService,
      checkpoint: this.chatCheckpointer,
      deleteThread: async (threadId) => {
        await this.chatCheckpointer.deleteThread(threadId);
        await this.capabilityRegistry.deleteThreadArtifacts(threadId);
      },
      inflightRequests: this.inflightRequests,
      isCurrentSocket: (ws) => this.appWsClient?.isCurrentSocket(ws) ?? false,
      getActorId: () => this.getActorId(),
      getLlmConfig: () => this.llmConfig,
      getPluginToolkits: () => this.pluginToolkits,
      getLocalToolkits: () => this.capabilityRegistry.getLocalToolkits(),
      getLocalCapabilities: () => this.capabilityRegistry.getLocalCapabilities(),
      getUserCapabilities: () => this.capabilityRegistry.getUserCapabilities(),
      getCapabilityArtifactStore: () => this.capabilityRegistry.getCapabilityArtifactStore(),
      getWorkdir: () => this.runtimeConfig.workdir,
      getActorName: () => this.actorName,
      runStudioRequest: async (ws, message) => {
        await this.studioHandler.handleStudioRequest(ws, message, this.buildLocalServerDeps());
      },
      routeStudioHumanReviewResponse: (ws, msg) => this.studioHandler.routeHumanReviewResponse(ws, msg),
      rejectStudioPendingReview: (ws) => {
        this.studioReviewRouter.rejectAndDelete(ws, new Error('app websocket closed'));
      },
    });
  }

  private buildLocalServerDeps(): LocalServerDeps {
    return {
      actorId: this.getActorId(),
      actorName: this.actorName ?? undefined,
      llmConfig: this.getLlmConfig(),
      workdir: this.runtimeConfig.workdir,
      runtimeConfig: this.runtimeConfig,
      studioDueRunScheduler: this.studioDueRunScheduler,
      localToolkitDefinitions: this.getLocalToolkitDefinitions(),
      localToolkits: this.getLocalToolkits(),
      pluginToolkits: this.getPluginToolkits(),
      localCapabilityDefinitions: this.getLocalCapabilityDefinitions(),
      localCapabilities: this.getLocalCapabilities(),
      userCapabilityDefinitions: this.getUserCapabilityDefinitions(),
      userCapabilities: this.getUserCapabilities(),
      capabilityArtifactStore: this.capabilityRegistry.getCapabilityArtifactStore(),
      rescanUserCapabilities: () => this.rescanUserCapabilities(),
    };
  }

  getRuntimeConfig(): LocalAgentRuntimeConfig {
    return this.runtimeConfig;
  }

  async init() {
    const { plugins, toolkits } = await loadPlugins();
    this.llmConfig = buildLocalLlmConfig();
    this.pluginToolkits = toolkits;
    await this.capabilityRegistry.load();
    this.hooks = collectPluginHooks(plugins);
    this.actorId = await ensureActorSelected({ interactive: false });
    this.actorName = loadSelectedActorName();
    const ctx = await loadAgentContext(this.actorId);
    // Backfill name from DB in case config was written before actor_name was tracked
    if (!this.actorName && ctx.pet.name) {
      this.actorName = ctx.pet.name;
      saveStoredConfig({ ...loadStoredConfig(), actor_name: ctx.pet.name });
    }

    return this.hooks;
  }

  requestStop() {
    this.stopRequested = true;
    this.studioDueRunScheduler.stop();
    this.disconnectWs();
  }

  getLlmConfig(): AgentLlmConfig {
    return this.llmConfig ?? buildLocalLlmConfig();
  }

  getPluginToolkits(): AgentToolkit[] {
    return this.pluginToolkits;
  }

  getLocalToolkits(): AgentToolkit[] {
    return this.capabilityRegistry.getLocalToolkits();
  }

  getLocalToolkitDefinitions(): AgentToolkit[] {
    return this.capabilityRegistry.getLocalToolkitDefinitions();
  }

  getLocalCapabilities(): AgentCapability[] {
    return this.capabilityRegistry.getLocalCapabilities();
  }

  getCapabilityArtifactStore() {
    return this.capabilityRegistry.getCapabilityArtifactStore();
  }

  getLocalCapabilityDefinitions(): AgentCapability[] {
    return this.capabilityRegistry.getLocalCapabilityDefinitions();
  }

  getUserCapabilities(): LoadedUserCapability[] {
    return this.capabilityRegistry.getUserCapabilities();
  }

  getUserCapabilityDefinitions(): LoadedUserCapability[] {
    return this.capabilityRegistry.getUserCapabilityDefinitions();
  }

  async rescanUserCapabilities(): Promise<{
    userCapabilityDefinitions: LoadedUserCapability[];
    userCapabilities: LoadedUserCapability[];
  }> {
    return this.capabilityRegistry.rescanUserCapabilities();
  }

  getActorId(): string {
    if (!this.actorId) {
      throw new Error('Local agent actorId is not initialized');
    }
    return this.actorId;
  }

  getActorName(): string | null {
    return this.actorName;
  }

  async runForever(opts?: { skipInit?: boolean }) {
    if (!opts?.skipInit) {
      await this.init();
    }
    console.log('[local-agent] started — local server + chat relay');

    if (config.apiConnected) {
      // Connect WebSocket for app ↔ local agent chat relay.
      this.connectWs();
    } else {
      console.log(`[local-agent] ${config.apiSetupMessage}`);
    }

    // Keep the process alive for the local server + WebSocket relay until stop.
    while (!this.stopRequested) {
      await sleep(config.pollIntervalSeconds * 1000);
    }

    console.log('[local-agent] stopped');
  }

  // ---- WebSocket connection ----

  connectWs() {
    if (this.stopRequested) return;
    if (!config.apiConnected) {
      console.log(`[local-agent] hosted app WebSocket disabled: ${config.apiSetupMessage}`);
      return;
    }
    if (!this.actorId) {
      throw new Error('Local agent actorId is missing; run init() before connectWs()');
    }

    const wsUrl = `${config.apiBaseUrl.replace(/^https?/, (m) => m === 'https' ? 'wss' : 'ws')}/ws/agent?token=${encodeURIComponent(config.agentToken)}&actorId=${encodeURIComponent(this.actorId)}`;

    this.disconnectWs();
    this.appWsClient = new LocalAgentAppWsClient({
      actorId: this.actorId,
      url: wsUrl,
      reconnectDelayMs: WS_RECONNECT_DELAY_MS,
      pingIntervalMs: WS_PING_INTERVAL_MS,
      handlers: {
        onChatRequest: (ws, msg) => this.appChatHandler.handleChatRequest(ws, msg),
        onStudioRequest: (ws, msg) => this.appChatHandler.handleStudioRequest(ws, msg),
        onNewSession: (_ws, msg) => this.appChatHandler.handleNewSession(msg),
        onInterruptRequest: (ws, msg) => this.appChatHandler.handleInterruptRequest(ws, msg),
        onHumanReviewResponse: (ws, msg) => this.appChatHandler.handleHumanReviewResponse(ws, msg),
        onClose: (ws) => this.appChatHandler.handleClose(ws),
      },
    });
    this.appWsClient.connect();
  }

  private disconnectWs() {
    const client = this.appWsClient;
    const ws = client?.getCurrentSocket() ?? null;
    if (ws) {
      const inflight = this.inflightRequests.get(ws);
      if (inflight && ws.readyState === WebSocket.OPEN) {
        this.inflightRequests.finish(ws, inflight, 'interrupted');
      }
      this.inflightRequests.abortAndClear(ws, inflight);
    }
    client?.disconnect();
    this.appWsClient = null;
  }
}
