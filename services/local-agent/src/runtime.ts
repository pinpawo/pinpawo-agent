import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { FileSaver } from './fileSaver';
import { getConfig } from './config';
import { loadAgentContext } from './contextLoader';
import {
  type AgentCapability,
  type AgentToolkit,
  type ToolkitRuntimeDiagnostic,
  type ToolkitRuntimeManager,
} from '@pinpawo/pet-agent';
import {
  createBrowserCapability,
  createBrowserToolkit,
} from '@pinpawo-toolkit/browser';
import { loadPlugins } from './pluginLoader';
import type { LoadedUserCapability } from './capabilityLoader';
import {
  buildLocalModelProfileRegistry,
  type LocalModelProfileRegistry,
} from './llmConfig';
import { LocalAgentGraphService } from './agentGraphService';
import { ensureActorSelected, loadSelectedActorName, LOCAL_ONLY_ACTOR_NAME } from './actorSelection';
import { loadStoredConfig, saveStoredConfig } from './storage';
import {
  sendLocalAgentEvent,
  sendLocalAgentMessage,
} from './localAgentProtocol';
import { InflightRequestController } from './inflightRequestController';
import { LocalAgentAppWsClient } from './localAgentAppWsClient';
import { LocalAgentAppChatHandler } from './localAgentAppChatHandler';
import {
  createCoreLocalCapabilities,
  LocalAgentCapabilityRegistry,
} from './localAgentCapabilityRegistry';
import {
  buildLocalAgentRuntimeConfig,
  findLegacyLocalAgentState,
  type LocalAgentRuntimeConfig,
} from './runtimeConfig';
import { LocalServerStudioHandler } from './localServerStudioHandler';
import type { LocalServerDeps } from './localServerTypes';
import { DEFAULT_SERVER_MODE, type ServerMode } from './serverMode';
import { createBashToolkit, createGitToolkit } from './toolkits/local';
import { HostToolkitCoordinator } from './toolkits/hostToolkitCoordinator';
import type { HostToolkitInventoryStore } from './toolkits/toolkitInventory';

const WS_RECONNECT_DELAY_MS = 10000;
const WS_PING_INTERVAL_MS = 30000;

export class LocalAgentRuntime {
  private readonly runtimeConfig: LocalAgentRuntimeConfig;
  private readonly serverMode: ServerMode;
  private stopRequested = false;
  private readonly stopController = new AbortController();
  private actorId: string | null = null;
  private actorName: string | null = null;
  private modelProfiles: LocalModelProfileRegistry | null = null;
  private readonly toolkitCoordinator = new HostToolkitCoordinator();
  private readonly hostBuiltInToolkits: readonly AgentToolkit[];
  private readonly capabilityRegistry: LocalAgentCapabilityRegistry;
  private readonly chatCheckpointer: FileSaver;
  private readonly graphService = new LocalAgentGraphService();
  private readonly inflightRequests = new InflightRequestController<WebSocket>({
    // Hosted app WS relay: do NOT include raw — keeps payloads small and
    // avoids leaking raw tool input/output through the remote channel.
    emitOperation: (ws, event) => sendLocalAgentEvent(ws, event),
    sendControl: (ws, message) => sendLocalAgentMessage(ws, message),
  });
  private readonly studioHandler: LocalServerStudioHandler<WebSocket>;
  private appWsClient: LocalAgentAppWsClient | null = null;
  private readonly appChatHandler: LocalAgentAppChatHandler;
  private legacyStateNoticeReported = false;

  constructor(
    runtimeConfig: LocalAgentRuntimeConfig = buildLocalAgentRuntimeConfig(),
    serverMode: ServerMode = DEFAULT_SERVER_MODE,
  ) {
    this.runtimeConfig = runtimeConfig;
    this.serverMode = serverMode;
    const browserSelected = loadStoredConfig().capabilities?.browser !== false;
    this.hostBuiltInToolkits = [
      createBashToolkit(),
      createGitToolkit(),
      ...(browserSelected
        ? [createBrowserToolkit({ backend: () => getConfig().browserBackend })]
        : []),
    ];
    this.capabilityRegistry = new LocalAgentCapabilityRegistry({
      capabilityArtifactRoot: runtimeConfig.capabilityArtifactRoot,
      createDefaultCapabilities: () => [
        ...createCoreLocalCapabilities(),
        ...(browserSelected ? [createBrowserCapability()] : []),
      ],
    });
    this.studioHandler = new LocalServerStudioHandler<WebSocket>({
      outbound: {
        sendMessage: (ws, message) => sendLocalAgentMessage(ws, message),
        sendEvent: (ws, event) => sendLocalAgentEvent(ws, event),
      },
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
      getModelProfiles: () => this.getModelProfiles(),
      getToolkitInventory: () => this.toolkitCoordinator.getInventoryStore().getSnapshot(),
      getToolkitRuntimeManager: () => this.toolkitCoordinator.getRuntimeManager(),
      getLocalCapabilities: () => this.capabilityRegistry.getLocalCapabilities(),
      getUserCapabilities: () => this.capabilityRegistry.getUserCapabilities(),
      getCapabilityArtifactStore: () => this.capabilityRegistry.getCapabilityArtifactStore(),
      getWorkdir: () => this.runtimeConfig.workdir,
      getActorName: () => this.actorName,
      runStudioRequest: async (ws, message) => {
        await this.studioHandler.handleStudioRequest(ws, message, this.buildLocalServerDeps());
      },
      rejectStudioPendingReview: (ws) => this.studioHandler.rejectDisconnected(ws),
    });
  }

  private buildLocalServerDeps(): LocalServerDeps {
    return {
      serverMode: this.serverMode,
      actorId: this.getActorId(),
      actorName: this.actorName ?? undefined,
      chatCheckpointer: this.chatCheckpointer,
      modelProfiles: this.getModelProfiles(),
      globalReviewPolicyMode: getConfig().globalReviewPolicyMode,
      autoAuthorizationSafetyLevel: getConfig().autoAuthorizationSafetyLevel,
      workdir: this.runtimeConfig.workdir,
      runtimeConfig: this.runtimeConfig,
      toolkitInventory: this.getToolkitInventoryStore(),
      toolkitRuntimeManager: this.getToolkitRuntimeManager(),
      localCapabilities: this.getLocalCapabilities(),
      userCapabilities: this.getUserCapabilities(),
      capabilityArtifactStore: this.capabilityRegistry.getCapabilityArtifactStore(),
      rescanUserCapabilities: () => this.rescanUserCapabilities(),
    };
  }

  /** Host 持有的 chat checkpointer;Studio 的 pet 复用同一实例(#613)。 */
  getChatCheckpointer(): FileSaver {
    return this.chatCheckpointer;
  }

  getRuntimeConfig(): LocalAgentRuntimeConfig {
    return this.runtimeConfig;
  }

  async init() {
    if (!this.legacyStateNoticeReported) {
      this.legacyStateNoticeReported = true;
      const legacyStatePaths = findLegacyLocalAgentState(this.runtimeConfig);
      if (legacyStatePaths.length > 0) {
        console.warn(
          '[local-agent] Capability V2 uses a new conversation checkpoint namespace. '
          + `Legacy state is preserved but not loaded: ${legacyStatePaths.join(', ')}`,
        );
      }
    }
    const { toolkitSources } = await loadPlugins();
    this.modelProfiles = buildLocalModelProfileRegistry();
    await this.toolkitCoordinator.initialize([
      ...toolkitSources,
      {
        id: 'local-agent',
        kind: 'host_builtin',
        definitions: this.hostBuiltInToolkits,
      },
    ]);
    await this.capabilityRegistry.load();
    this.actorId = await ensureActorSelected({ interactive: false });
    this.actorName = getConfig().apiConnected ? loadSelectedActorName() : LOCAL_ONLY_ACTOR_NAME;
    const ctx = await loadAgentContext(this.actorId);
    // Backfill name from DB in case config was written before actor_name was tracked
    if (!this.actorName && ctx.pet.name) {
      this.actorName = ctx.pet.name;
      saveStoredConfig({ ...loadStoredConfig(), actor_name: ctx.pet.name });
    }

  }

  requestStop() {
    this.stopRequested = true;
    this.stopController.abort();
    this.disconnectWs();
  }

  async shutdown() {
    this.requestStop();
    await this.toolkitCoordinator.shutdown();
  }

  getToolkitRuntimeManager(): ToolkitRuntimeManager {
    return this.toolkitCoordinator.getRuntimeManager();
  }

  getToolkitRuntimeDiagnostics(): Promise<readonly ToolkitRuntimeDiagnostic[]> {
    return this.toolkitCoordinator.diagnose();
  }

  getModelProfiles(): LocalModelProfileRegistry {
    return this.modelProfiles ?? buildLocalModelProfileRegistry();
  }

  getToolkitInventoryStore(): HostToolkitInventoryStore {
    return this.toolkitCoordinator.getInventoryStore();
  }

  getLocalCapabilities(): AgentCapability[] {
    return this.capabilityRegistry.getLocalCapabilities();
  }

  getCapabilityArtifactStore() {
    return this.capabilityRegistry.getCapabilityArtifactStore();
  }

  getUserCapabilities(): LoadedUserCapability[] {
    return this.capabilityRegistry.getUserCapabilities();
  }

  async rescanUserCapabilities(): Promise<LoadedUserCapability[]> {
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

    const config = getConfig();
    if (config.apiConnected) {
      // Connect WebSocket for app ↔ local agent chat relay.
      this.connectWs();
    } else {
      console.log(`[local-agent] ${config.apiSetupMessage}`);
    }

    // Keep the process alive for the local server + WebSocket relay until stop.
    while (!this.stopRequested) {
      try {
        await sleep(
          config.pollIntervalSeconds * 1000,
          undefined,
          { signal: this.stopController.signal },
        );
      } catch (error) {
        if (this.stopController.signal.aborted) {
          break;
        }
        throw error;
      }
    }

    console.log('[local-agent] stopped');
  }

  // ---- WebSocket connection ----

  connectWs() {
    const config = getConfig();
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
        onReviewCancel: (ws, msg) => this.appChatHandler.handleReviewCancel(ws, msg),
        onRunInterrupt: (ws, msg) => this.appChatHandler.handleRunInterrupt(ws, msg),
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
      this.inflightRequests.abortAll(ws);
      this.studioHandler.rejectDisconnected(ws);
    }
    client?.disconnect();
    this.appWsClient = null;
  }
}
