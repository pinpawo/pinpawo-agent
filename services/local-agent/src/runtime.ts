import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { FileSaver } from './fileSaver';
import { getConfig } from './config';
import {
  sendLocalAgentEvent,
  sendLocalAgentMessage,
} from './localAgentProtocol';
import { InflightRequestController } from './inflightRequestController';
import { LocalAgentAppWsClient } from './localAgentAppWsClient';
import { LocalAgentAppChatHandler } from './localAgentAppChatHandler';
import { LocalAgentGraphService } from './agentGraphService';
import { HostCapabilityAssembly } from './hostCapabilityAssembly';
import {
  buildLocalAgentRuntimeConfig,
  type LocalAgentRuntimeConfig,
} from './runtimeConfig';
import type { LocalServerDeps } from './localServerTypes';
import { DEFAULT_SERVER_MODE, type ServerMode } from './serverMode';

const WS_RECONNECT_DELAY_MS = 10000;
const WS_PING_INTERVAL_MS = 30000;

/**
 * Chat Host — assembles capability supply via {@link HostCapabilityAssembly},
 * then adds chat/ws-relay concerns that Studio Host does not need.
 *
 * `--mode studio` uses {@link StudioHost} instead; the two hosts share the
 * same capability supply but not the same transport or relay concerns.
 */
export class LocalAgentHost {
  private readonly caps: HostCapabilityAssembly;
  private readonly serverMode: ServerMode;
  private stopRequested = false;
  private readonly stopController = new AbortController();
  private readonly graphService = new LocalAgentGraphService();
  private readonly inflightRequests = new InflightRequestController<WebSocket>({
    // Hosted app WS relay: do NOT include raw — keeps payloads small and
    // avoids leaking raw tool input/output through the remote channel.
    emitOperation: (ws, event) => sendLocalAgentEvent(ws, event),
    sendControl: (ws, message) => sendLocalAgentMessage(ws, message),
  });
  private appWsClient: LocalAgentAppWsClient | null = null;
  private readonly appChatHandler: LocalAgentAppChatHandler;

  constructor(
    runtimeConfig: LocalAgentRuntimeConfig = buildLocalAgentRuntimeConfig(),
    serverMode: ServerMode = DEFAULT_SERVER_MODE,
  ) {
    this.caps = new HostCapabilityAssembly({
      runtimeConfig,
      sourceId: 'local-agent',
    });
    this.serverMode = serverMode;
    this.appChatHandler = new LocalAgentAppChatHandler({
      graphService: this.graphService,
      checkpoint: this.caps.getChatCheckpointer(),
      deleteThread: async (threadId) => {
        await this.caps.getChatCheckpointer().deleteThread(threadId);
        await this.caps.deleteThreadArtifacts(threadId);
      },
      inflightRequests: this.inflightRequests,
      isCurrentSocket: (ws) => this.appWsClient?.isCurrentSocket(ws) ?? false,
      getActorId: () => this.caps.getActorId(),
      getModelProfiles: () => this.caps.getModelProfiles(),
      getToolkitInventory: () => this.caps.getToolkitInventoryStore().getSnapshot(),
      getToolkitRuntimeManager: () => this.caps.getToolkitRuntimeManager(),
      getLocalCapabilities: () => this.caps.getLocalCapabilities(),
      getUserCapabilities: () => this.caps.getUserCapabilities(),
      getCapabilityArtifactStore: () => this.caps.getCapabilityArtifactStore(),
      getWorkdir: () => this.caps.getRuntimeConfig().workdir,
      getActorName: () => this.caps.getActorName(),
    });
  }

  async init() {
    await this.caps.init();
  }

  requestStop() {
    this.stopRequested = true;
    this.stopController.abort();
    this.disconnectWs();
  }

  async shutdown() {
    this.requestStop();
    await this.caps.shutdown();
  }

  // ---- Capability supply delegation ----

  getRuntimeConfig(): LocalAgentRuntimeConfig {
    return this.caps.getRuntimeConfig();
  }

  /** Host 持有的 chat checkpointer;Studio 的 pet 复用同一实例(#613)。 */
  getChatCheckpointer(): FileSaver {
    return this.caps.getChatCheckpointer();
  }

  getToolkitRuntimeManager() {
    return this.caps.getToolkitRuntimeManager();
  }

  getToolkitRuntimeDiagnostics() {
    return this.caps.getToolkitRuntimeDiagnostics();
  }

  getModelProfiles() {
    return this.caps.getModelProfiles();
  }

  getToolkitInventoryStore() {
    return this.caps.getToolkitInventoryStore();
  }

  getLocalCapabilities() {
    return this.caps.getLocalCapabilities();
  }

  getCapabilityArtifactStore() {
    return this.caps.getCapabilityArtifactStore();
  }

  getUserCapabilities() {
    return this.caps.getUserCapabilities();
  }

  async rescanUserCapabilities() {
    return this.caps.rescanUserCapabilities();
  }

  getActorId(): string {
    return this.caps.getActorId();
  }

  getActorName(): string | null {
    return this.caps.getActorName();
  }

  // ---- Chat/ws-relay concerns (host-specific) ----

  private buildLocalServerDeps(): LocalServerDeps {
    return {
      serverMode: this.serverMode,
      actorId: this.getActorId(),
      actorName: this.getActorName() ?? undefined,
      chatCheckpointer: this.getChatCheckpointer(),
      modelProfiles: this.getModelProfiles(),
      globalReviewPolicyMode: getConfig().globalReviewPolicyMode,
      autoAuthorizationSafetyLevel: getConfig().autoAuthorizationSafetyLevel,
      workdir: this.getRuntimeConfig().workdir,
      runtimeConfig: this.getRuntimeConfig(),
      toolkitInventory: this.getToolkitInventoryStore(),
      toolkitRuntimeManager: this.getToolkitRuntimeManager(),
      localCapabilities: this.getLocalCapabilities(),
      userCapabilities: this.getUserCapabilities(),
      capabilityArtifactStore: this.getCapabilityArtifactStore(),
      rescanUserCapabilities: () => this.rescanUserCapabilities(),
    };
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
    if (!this.getActorId()) {
      throw new Error('Local agent actorId is missing; run init() before connectWs()');
    }

    const wsUrl = `${config.apiBaseUrl.replace(/^https?/, (m) => m === 'https' ? 'wss' : 'ws')}/ws/agent?token=${encodeURIComponent(config.agentToken)}&actorId=${encodeURIComponent(this.getActorId())}`;

    this.disconnectWs();
    this.appWsClient = new LocalAgentAppWsClient({
      actorId: this.getActorId(),
      url: wsUrl,
      reconnectDelayMs: WS_RECONNECT_DELAY_MS,
      pingIntervalMs: WS_PING_INTERVAL_MS,
      handlers: {
        onChatRequest: (ws, msg) => this.appChatHandler.handleChatRequest(ws, msg),
        onStudioRequest: (ws, msg) => {
          sendLocalAgentMessage(ws, {
            type: 'studio_error',
            requestId: msg.requestId,
            message: 'This server runs in chat mode; studio requests are not accepted.',
          });
        },
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
    }
    client?.disconnect();
    this.appWsClient = null;
  }
}
