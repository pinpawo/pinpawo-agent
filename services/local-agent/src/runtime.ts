import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { FileSaver } from './fileSaver';
import { config } from './config';
import { loadAgentContext, sendHeartbeat, getNextTickAt } from './contextLoader';
import { generateCrawlKeywords, ingestCrawlerResults, runMediaCrawler } from './crawler';
import {
  dailyPostResultSchema,
  type AgentCapability,
  type AgentToolkit,
  type DailyPostResult,
} from '@pinpawo/pet-agent';
import { collectPluginHooks, loadPlugins } from './pluginLoader';
import { loadUserCapabilities } from './capabilityLoader';
import type { LoadedUserCapability } from './capabilityLoader';
import { createBashToolkit, loadLocalPluginTools } from './plugins/localTools';
import {
  resolveAvailableCapabilities,
  resolveAvailableToolkits,
  resolveCapabilityAvailability,
} from './capabilities/capabilityAvailability';
import { createBrowserCapability, createBrowserToolkit } from './capabilities/browserCapability';
import type { StructuredTool } from '@langchain/core/tools';
import type { AgentLlmConfig } from './agentConfig';
import {
  buildLocalLlmConfig,
} from './llmConfig';
import { buildLocalScheduledAgentInput } from './agentChannel';
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

const WS_RECONNECT_DELAY_MS = 10000;
const WS_PING_INTERVAL_MS = 30000;
const INTERRUPT_FORCE_REPLY_MS = 1800;

async function filterAvailableUserCapabilities(
  loaded: LoadedUserCapability[],
  options: { force?: boolean } = {},
): Promise<LoadedUserCapability[]> {
  const records = await Promise.all(
    loaded.map(async (item) => ({
      item,
      availability: await resolveCapabilityAvailability(item.capability, options),
    })),
  );
  return records
    .filter((record) => record.availability.availability.available)
    .map((record) => record.item);
}

export class LocalAgentRuntime {
  private stopRequested = false;
  private lastHeartbeatAt = 0;
  private lastPostAt = 0;
  private actorId: string | null = null;
  private actorName: string | null = null;
  private readonly startedAt = new Date().toISOString();
  private totalRuns = 0;
  private successfulRuns = 0;
  private failedRuns = 0;
  private lastRunAt: string | null = null;
  private lastRunOk: boolean | null = null;
  private llmConfig: AgentLlmConfig | null = null;
  private hooks: ReturnType<typeof collectPluginHooks> | null = null;
  private pluginTools: StructuredTool[] = [];
  private localTools: StructuredTool[] = [];
  private localToolkitDefinitions: AgentToolkit[] = [];
  private localToolkits: AgentToolkit[] = [];
  private localCapabilityDefinitions: AgentCapability[] = [];
  private localCapabilities: AgentCapability[] = [];
  private userCapabilityDefinitions: LoadedUserCapability[] = [];
  private userCapabilities: LoadedUserCapability[] = [];
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
    getPluginTools: () => this.pluginTools,
    getLocalToolkits: () => this.localToolkits,
    getLocalCapabilities: () => this.localCapabilities,
    getUserCapabilities: () => this.userCapabilities,
  });

  async init() {
    const { plugins, tools } = await loadPlugins();
    this.llmConfig = buildLocalLlmConfig();
    this.pluginTools = tools;
    this.localTools = await loadLocalPluginTools();
    this.localToolkitDefinitions = [
      createBashToolkit(this.localTools),
      createBrowserToolkit(),
    ];
    this.localToolkits = await resolveAvailableToolkits(this.localToolkitDefinitions);
    this.localCapabilityDefinitions = [
      createBrowserCapability(),
    ];
    this.localCapabilities = await resolveAvailableCapabilities(this.localCapabilityDefinitions);
    this.hooks = collectPluginHooks(plugins);
    this.userCapabilityDefinitions = await loadUserCapabilities();
    this.userCapabilities = await filterAvailableUserCapabilities(this.userCapabilityDefinitions);
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

  getPluginTools(): StructuredTool[] {
    return this.pluginTools;
  }

  getLocalTools(): StructuredTool[] {
    return this.localTools;
  }

  getLocalToolkits(): AgentToolkit[] {
    return this.localToolkits;
  }

  getLocalToolkitDefinitions(): AgentToolkit[] {
    return this.localToolkitDefinitions;
  }

  getLocalCapabilities(): AgentCapability[] {
    return this.localCapabilities;
  }

  getLocalCapabilityDefinitions(): AgentCapability[] {
    return this.localCapabilityDefinitions;
  }

  getUserCapabilities(): LoadedUserCapability[] {
    return this.userCapabilities;
  }

  getUserCapabilityDefinitions(): LoadedUserCapability[] {
    return this.userCapabilityDefinitions;
  }

  async rescanUserCapabilities(): Promise<{
    userCapabilityDefinitions: LoadedUserCapability[];
    userCapabilities: LoadedUserCapability[];
  }> {
    this.userCapabilityDefinitions = await loadUserCapabilities();
    this.userCapabilities = await filterAvailableUserCapabilities(
      this.userCapabilityDefinitions,
      { force: true },
    );
    return {
      userCapabilityDefinitions: this.userCapabilityDefinitions,
      userCapabilities: this.userCapabilities,
    };
  }

  getStats() {
    return {
      startedAt: this.startedAt,
      totalRuns: this.totalRuns,
      successfulRuns: this.successfulRuns,
      failedRuns: this.failedRuns,
      lastRunAt: this.lastRunAt,
      lastRunOk: this.lastRunOk,
    };
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
        await this.tick();
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

  // ---- Post generation tick ----

  private async tick() {
    const now = Date.now();

    // Heartbeat via GraphQL
    if (now - this.lastHeartbeatAt >= config.heartbeatIntervalSeconds * 1000) {
      await sendHeartbeat(this.getActorId());
      this.lastHeartbeatAt = now;
      console.log('[local-agent] heartbeat sent');
    }

    // Check next_tick_at from DB (authoritative) — fall back to local timer
    const nextTickAt = await getNextTickAt(this.getActorId());
    if (nextTickAt && nextTickAt.getTime() > now) {
      return;
    }
    if (!nextTickAt && now - this.lastPostAt < config.postIntervalHours * 3600 * 1000) {
      return;
    }

    const initialCtx = await loadAgentContext(this.getActorId());
    const recentTopics = initialCtx.context.recentDaily
      .slice(0, 5)
      .map((p) => p.topic)
      .filter((t): t is string => Boolean(t));
    const crawlKeywords = await generateCrawlKeywords({
      pet: {
        name: initialCtx.pet.name,
        personality: initialCtx.pet.personality ?? null,
        species: initialCtx.pet.species ?? null,
      },
      recentTopics,
      today: initialCtx.context.today,
    });

    // Run plugin hooks + MediaCrawler
    try {
      await this.hooks!.beforeCrawl();
      await runMediaCrawler({ keywords: crawlKeywords, maxCount: 10 });
      await ingestCrawlerResults(10);
    } catch (err) {
      console.warn('[local-agent] crawler failed, continuing with existing trends:', err instanceof Error ? err.message : err);
    }

    console.log('[local-agent] loading context...');
    const ctx = await loadAgentContext(this.getActorId());
    console.log(`[local-agent] pet: ${ctx.pet.name}, trends: ${ctx.context.trendItems.length}`);

    console.log('[local-agent] running agent...');
    this.totalRuns++;
    this.lastRunAt = new Date().toISOString();
    try {
        const setup = buildLocalScheduledAgentInput({
          context: ctx,
          llmConfig: this.llmConfig ?? buildLocalLlmConfig(),
          dryRun: false,
          toolkits: this.localToolkits,
          userCapabilities: this.userCapabilities,
        });
        const { result } = await this.graphService.invokeStructuredResult(
          setup,
          dailyPostResultSchema,
        );
        const dailyPostResult: DailyPostResult = result
          ? result as DailyPostResult
          : { status: 'skipped', postId: null, reason: 'no-post', payload: null, imageRequested: false };
        console.log(`[local-agent] result: ${dailyPostResult.status}${dailyPostResult.postId ? ` post=${dailyPostResult.postId}` : ''}${dailyPostResult.reason ? ` reason=${dailyPostResult.reason}` : ''}`);
        this.lastPostAt = now;
        this.successfulRuns++;
        this.lastRunOk = true;
        if (dailyPostResult.status === 'created' && dailyPostResult.postId && dailyPostResult.payload) {
          await this.hooks?.afterPostSaved(dailyPostResult.postId, dailyPostResult.payload);
        }
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 429) {
          console.log('[local-agent] rate limited by server, backing off');
          this.lastPostAt = now;
          this.successfulRuns++;
          this.lastRunOk = true;
        } else {
          this.failedRuns++;
          this.lastRunOk = false;
          throw err;
        }
      }
  }
}
