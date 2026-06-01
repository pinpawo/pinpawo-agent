import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
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
import { buildLocalChatAgentInput, buildLocalScheduledAgentInput } from './agentChannel';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { LocalAgentGraphService } from './agentGraphService';
import { ensureActorSelected, loadSelectedActorName } from './actorSelection';
import { loadStoredConfig, saveStoredConfig } from './storage';
import { buildAppChatThreadId } from './chatInterface';
import {
  parseLocalAgentClientMessage,
  sendLocalAgentEvent,
  sendLocalAgentMessage,
  type ChatRequestMessage,
  type InterruptRequestMessage,
  type NewSessionMessage,
} from './localAgentProtocol';
import { recordAgentRunActivity, recordToolActivity } from './toolActivityState';
import {
  buildToolOperationEvent,
  type StreamToolsPayload,
} from './agentStreamEvents';
import type { LocalAgentOperationPhase } from './events/localAgentEvent';
import { runChatSession } from './chatSessionAdapter';

const WS_RECONNECT_DELAY_MS = 10000;
const WS_PING_INTERVAL_MS = 30000;
const INTERRUPT_FORCE_REPLY_MS = 1800;

type InflightRequest = {
  requestId: string;
  controller: AbortController;
  interruptedSent?: boolean;
  interruptTimer?: ReturnType<typeof setTimeout>;
};

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

function sendToolOperationEvent(ws: WebSocket, requestId: string, payload: StreamToolsPayload) {
  const event = buildToolOperationEvent(requestId, payload);
  recordToolActivity(payload.name, toToolActivityPhase(event.phase), requestId);
  sendLocalAgentEvent(ws, event);
}

function toToolActivityPhase(phase: LocalAgentOperationPhase) {
  if (phase === 'started') return 'start';
  if (phase === 'completed') return 'end';
  if (phase === 'failed') return 'error';
  if (phase === 'interrupted') return 'interrupt';
  return 'event';
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
  private ws: WebSocket | null = null;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wsPingInterval: ReturnType<typeof setInterval> | null = null;
  private sessionResetPromise: Promise<void> = Promise.resolve();
  private inflightRequest: InflightRequest | null = null;

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
    console.log(`[local-agent] connecting WS... actorId=${this.actorId}`);

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.on('open', () => {
      console.log('[local-agent] WS connected');
      this.wsPingInterval = setInterval(() => {
        sendLocalAgentMessage(ws, { type: 'pong' });
      }, WS_PING_INTERVAL_MS);
    });

    ws.on('message', (data: Buffer | string) => {
      try {
        const msg = parseLocalAgentClientMessage(data);
        if (!msg) return;
        if (msg.type === 'ping') {
          sendLocalAgentMessage(ws, { type: 'pong' });
        } else if (msg.type === 'chat_request') {
          this.handleChatRequest(msg).catch((err) => {
            console.error('[local-agent] handleChatRequest error:', err instanceof Error ? err.message : err);
          });
        } else if (msg.type === 'new_session') {
          this.sessionResetPromise = this.handleNewSession(msg).catch((err) => {
            console.error('[local-agent] new_session error:', err instanceof Error ? err.message : err);
          });
        } else if (msg.type === 'interrupt_request') {
          this.handleInterruptRequest(msg);
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('close', (code, reason) => {
      const detail = reason.length > 0 ? ` reason=${reason.toString()}` : '';
      console.log(`[local-agent] WS disconnected code=${code}${detail}`);
      this.clearWsPing();
      this.scheduleWsReconnect();
    });

    ws.on('error', (err: Error) => {
      console.warn('[local-agent] WS error:', err.message);
      this.clearWsPing();
    });
  }

  private disconnectWs() {
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    this.clearWsPing();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    if (this.inflightRequest) {
      this.clearInflightTimer(this.inflightRequest);
      this.inflightRequest.controller.abort();
      this.inflightRequest = null;
    }
  }

  private clearWsPing() {
    if (this.wsPingInterval) {
      clearInterval(this.wsPingInterval);
      this.wsPingInterval = null;
    }
  }

  private scheduleWsReconnect() {
    if (this.stopRequested) return;
    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = null;
      if (!this.stopRequested) this.connectWs();
    }, WS_RECONNECT_DELAY_MS);
  }

  // ---- Handle incoming chat_request from server ----

  private getChatThreadId(petId: string, userId: string) {
    return buildAppChatThreadId({ petId, userId });
  }

  private clearInflightTimer(inflight: InflightRequest) {
    if (inflight.interruptTimer) {
      clearTimeout(inflight.interruptTimer);
      inflight.interruptTimer = undefined;
    }
  }

  private clearInflightRequest(inflight: InflightRequest) {
    this.clearInflightTimer(inflight);
    if (this.inflightRequest === inflight) {
      this.inflightRequest = null;
    }
  }

  private sendInterrupted(ws: WebSocket, inflight: InflightRequest) {
    if (inflight.interruptedSent) {
      return;
    }
    inflight.interruptedSent = true;
    sendLocalAgentMessage(ws, {
      type: 'interrupted',
      requestId: inflight.requestId,
      message: 'interrupted',
    });
  }

  private interruptInflightRequest(inflight: InflightRequest, ws: WebSocket) {
    sendLocalAgentMessage(ws, {
      type: 'interrupting',
      requestId: inflight.requestId,
      message: 'interrupting',
    });
    inflight.controller.abort();
    if (inflight.interruptTimer) {
      return;
    }
    inflight.interruptTimer = setTimeout(() => {
      if (this.inflightRequest !== inflight || !inflight.controller.signal.aborted) {
        return;
      }
      this.sendInterrupted(ws, inflight);
      this.clearInflightRequest(inflight);
      console.warn(`[local-agent] force interrupted requestId=${inflight.requestId}`);
    }, INTERRUPT_FORCE_REPLY_MS);
  }

  private async handleNewSession(msg: NewSessionMessage) {
    const userId = msg.userId?.trim();
    if (!userId) {
      return;
    }

    const threadId = this.getChatThreadId(this.getActorId(), userId);
    await this.chatCheckpointer.deleteThread(threadId);
    console.log(`[local-agent] new session created threadId=${threadId}`);
  }

  private handleInterruptRequest(msg: InterruptRequestMessage) {
    const inflight = this.inflightRequest;
    const ws = this.ws;
    if (!inflight || !ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (msg.requestId && inflight.requestId !== msg.requestId) {
      return;
    }
    this.interruptInflightRequest(inflight, ws);
  }

  private async handleChatRequest(msg: ChatRequestMessage) {
    const { requestId, message } = msg;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const userId = msg.userId?.trim();
    if (!userId) {
      sendLocalAgentEvent(this.ws, {
        type: 'error',
        requestId,
        message: 'userId is required',
      });
      return;
    }

    await this.sessionResetPromise;

    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    console.log(`[local-agent] chat_request requestId=${requestId} message="${message.slice(0, 80)}"`);

    if (this.inflightRequest) {
      this.clearInflightTimer(this.inflightRequest);
      this.inflightRequest.controller.abort();
    }

    recordAgentRunActivity('thinking', requestId);

    const controller = new AbortController();
    const inflight: InflightRequest = { requestId, controller };
    this.inflightRequest = inflight;
    const isCurrent = () => this.inflightRequest === inflight && !controller.signal.aborted;
    const finishInterrupted = () => {
      if (!controller.signal.aborted) {
        return;
      }
      this.sendInterrupted(ws, inflight);
      this.clearInflightRequest(inflight);
    };

    try {
      const ctx = await loadAgentContext(this.getActorId());
      if (!isCurrent()) {
        finishInterrupted();
        return;
      }

      const setup = buildLocalChatAgentInput({
        context: ctx,
        userMessage: message,
        llmConfig: this.llmConfig ?? buildLocalLlmConfig(),
        tools: this.pluginTools,
        toolkits: this.localToolkits,
        extraCapabilities: this.localCapabilities,
        threadId: this.getChatThreadId(this.getActorId(), userId),
        dryRun: false,
        checkpoint: this.chatCheckpointer,
        userCapabilities: this.userCapabilities,
      });
      setup.input.signal = controller.signal;

      const result = await runChatSession({
        request: msg,
        setup,
        graphService: this.graphService,
        isCurrent,
        finishInterrupted,
        emitEvent: (event) => {
          sendLocalAgentEvent(ws, event);
        },
        emitToolEvent: (event) => {
          sendToolOperationEvent(ws, requestId, event);
        },
      });
      if (result.status === 'waiting_human') {
        console.log(`[local-agent] human_review.requested requestId=${requestId}`);
        this.clearInflightRequest(inflight);
        return;
      }
      if (result.status === 'interrupted') {
        return;
      }
      this.clearInflightRequest(inflight);

      console.log(`[local-agent] message.completed sent requestId=${requestId} reply="${result.reply.slice(0, 100)}"`);

    } catch (err) {
      const isStillCurrent = this.inflightRequest === inflight;
      const aborted = controller.signal.aborted
        || (err instanceof Error && err.name === 'AbortError');
      if (aborted) {
        console.warn(`[local-agent] chat interrupted requestId=${requestId}`);
        this.sendInterrupted(ws, inflight);
        recordAgentRunActivity('interrupted', requestId, 2_500);
        this.clearInflightRequest(inflight);
        return;
      }
      this.clearInflightRequest(inflight);
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
