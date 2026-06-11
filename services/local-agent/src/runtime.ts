import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { FileSaver } from './fileSaver';
import { config } from './config';
import { loadAgentContext } from './contextLoader';
import {
  type AgentCapability,
  type AgentToolkit,
} from '@pinpawo/pet-agent';
import { collectPluginHooks, loadPlugins } from './pluginLoader';
import type { LoadedUserCapability } from './capabilityLoader';
import type { AgentLlmConfig } from './agentConfig';
import {
  buildLocalLlmConfig,
} from './llmConfig';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
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
import { LocalAgentScheduledJob } from './localAgentScheduledJob';
import { LocalAgentCapabilityRegistry } from './localAgentCapabilityRegistry';

const WS_RECONNECT_DELAY_MS = 10000;
const WS_PING_INTERVAL_MS = 30000;
const INTERRUPT_FORCE_REPLY_MS = 1800;

export class LocalAgentRuntime {
  private stopRequested = false;
  private actorId: string | null = null;
  private actorName: string | null = null;
  private llmConfig: AgentLlmConfig | null = null;
  private hooks: ReturnType<typeof collectPluginHooks> | null = null;
  private pluginToolkits: AgentToolkit[] = [];
  private readonly capabilityRegistry = new LocalAgentCapabilityRegistry();
  private readonly chatCheckpointer = new FileSaver(
    resolve(homedir(), '.pinpawo', 'checkpoints.json'),
  );
  private readonly graphService = new LocalAgentGraphService();
  private appWsClient: LocalAgentAppWsClient | null = null;
  private readonly inflightRequests = new InflightRequestController<WebSocket>({
    forceInterruptMs: INTERRUPT_FORCE_REPLY_MS,
    emitOperation: (ws, event) => sendLocalAgentEvent(ws, event),
    sendControl: (ws, message) => sendLocalAgentMessage(ws, message),
    logPrefix: 'local-agent',
  });
  private readonly appChatHandler = new LocalAgentAppChatHandler({
    graphService: this.graphService,
    checkpoint: this.chatCheckpointer,
    deleteThread: (threadId) => this.chatCheckpointer.deleteThread(threadId),
    inflightRequests: this.inflightRequests,
    isCurrentSocket: (ws) => this.appWsClient?.isCurrentSocket(ws) ?? false,
    getActorId: () => this.getActorId(),
    getLlmConfig: () => this.llmConfig,
    getPluginToolkits: () => this.pluginToolkits,
    getLocalToolkits: () => this.capabilityRegistry.getLocalToolkits(),
    getLocalCapabilities: () => this.capabilityRegistry.getLocalCapabilities(),
    getUserCapabilities: () => this.capabilityRegistry.getUserCapabilities(),
  });
  private readonly scheduledJob = new LocalAgentScheduledJob({
    graphService: this.graphService,
    getActorId: () => this.getActorId(),
    getLlmConfig: () => this.llmConfig,
    getHooks: () => this.hooks,
    getLocalToolkits: () => this.capabilityRegistry.getLocalToolkits(),
    getUserCapabilities: () => this.capabilityRegistry.getUserCapabilities(),
  });

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

  getStats() {
    return this.scheduledJob.getStats();
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
    console.log(`[local-agent] started — poll every ${config.pollIntervalSeconds}s, post every ${config.postIntervalHours}h`);

    // Connect WebSocket for app ↔ local agent chat relay
    this.connectWs();

    while (!this.stopRequested) {
      try {
        await this.scheduledJob.tick();
      } catch (err) {
        console.error('[local-agent] tick error:', err instanceof Error ? err.message : err);
      }

      if (this.stopRequested) break;
      await sleep(config.pollIntervalSeconds * 1000);
    }

    console.log('[local-agent] stopped');
  }

  // ---- WebSocket connection ----

  connectWs() {
    if (this.stopRequested) return;
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
