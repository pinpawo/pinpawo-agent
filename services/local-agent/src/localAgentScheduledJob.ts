import {
  type AgentToolkit,
  type CapabilityArtifactRef,
  type OrchestratorStateType,
} from '@pinpawo/pet-agent';
import type { ZodType } from 'zod';
import {
  dailyPostResultSchema,
  type DailyPostPayload,
  type DailyPostResult,
} from './capabilities/dailyPost';
import { buildLocalScheduledAgentInput, type AgentChannelSetup } from './agentChannel';
import type { AgentLlmConfig } from './agentConfig';
import type { LocalAgentGraphService } from './agentGraphService';
import type { LoadedUserCapability } from './capabilityLoader';
import { config } from './config';
import { loadAgentContext, sendHeartbeat, getNextTickAt, type AgentContext } from './contextLoader';
import { generateCrawlKeywords, ingestCrawlerResults, runMediaCrawler } from './crawler';
import { buildLocalLlmConfig } from './llmConfig';
import type { AgentStats } from './localServerTypes';

export type LocalAgentScheduledHooks = {
  beforeCrawl: () => Promise<void>;
  afterPostSaved: (postId: string, payload: DailyPostPayload) => Promise<void>;
};

type LocalAgentScheduledJobTimings = {
  heartbeatIntervalSeconds: number;
  postIntervalHours: number;
};

type LocalAgentScheduledJobDeps = {
  now: () => number;
  loadContext: (actorId: string) => Promise<AgentContext>;
  sendHeartbeat: (actorId: string) => Promise<void>;
  getNextTickAt: (actorId: string) => Promise<Date | null>;
  generateCrawlKeywords: typeof generateCrawlKeywords;
  runMediaCrawler: typeof runMediaCrawler;
  ingestCrawlerResults: typeof ingestCrawlerResults;
  buildScheduledInput: typeof buildLocalScheduledAgentInput;
};

type ReadCapabilityArtifact = (params: {
  uri: string;
  maxBytes?: number;
  threadId?: string;
}) => Promise<{ ref: CapabilityArtifactRef; content: string | null }>;

export type LocalAgentScheduledJobOptions = {
  graphService: LocalAgentGraphService;
  getActorId: () => string;
  getLlmConfig: () => AgentLlmConfig | null;
  getHooks: () => LocalAgentScheduledHooks | null;
  getLocalToolkits: () => AgentToolkit[];
  getUserCapabilities: () => LoadedUserCapability[];
  readCapabilityArtifact: ReadCapabilityArtifact;
  timings?: LocalAgentScheduledJobTimings;
  deps?: Partial<LocalAgentScheduledJobDeps>;
};

function parseArtifactContent(content: string | null): unknown {
  if (content === null) return null;
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}

async function readLatestStructuredCapabilityResult<T extends Record<string, unknown>>(params: {
  state: OrchestratorStateType;
  schema: ZodType<T>;
  readArtifact: ReadCapabilityArtifact;
  threadId?: string;
}): Promise<T | null> {
  const latestResultRef = [...params.state.capabilityArtifacts]
    .reverse()
    .find((artifact) => artifact.kind === 'result');
  if (!latestResultRef) {
    return null;
  }
  const artifactContent = (await params.readArtifact({
    uri: latestResultRef.uri,
    threadId: params.threadId,
  })).content;
  const parsed = artifactContent !== null
    ? params.schema.safeParse(parseArtifactContent(artifactContent))
    : null;
  return parsed?.success ? parsed.data : null;
}

export class LocalAgentScheduledJob {
  private readonly graphService: LocalAgentGraphService;
  private readonly getActorId: () => string;
  private readonly getLlmConfig: () => AgentLlmConfig | null;
  private readonly getHooks: () => LocalAgentScheduledHooks | null;
  private readonly getLocalToolkits: () => AgentToolkit[];
  private readonly getUserCapabilities: () => LoadedUserCapability[];
  private readonly readCapabilityArtifact: ReadCapabilityArtifact;
  private readonly timings: LocalAgentScheduledJobTimings;
  private readonly deps: LocalAgentScheduledJobDeps;
  private readonly startedAt = new Date().toISOString();
  private lastHeartbeatAt = 0;
  private lastPostAt = 0;
  private totalRuns = 0;
  private successfulRuns = 0;
  private failedRuns = 0;
  private lastRunAt: string | null = null;
  private lastRunOk: boolean | null = null;

  constructor(options: LocalAgentScheduledJobOptions) {
    this.graphService = options.graphService;
    this.getActorId = options.getActorId;
    this.getLlmConfig = options.getLlmConfig;
    this.getHooks = options.getHooks;
    this.getLocalToolkits = options.getLocalToolkits;
    this.getUserCapabilities = options.getUserCapabilities;
    this.readCapabilityArtifact = options.readCapabilityArtifact;
    this.timings = options.timings ?? {
      heartbeatIntervalSeconds: config.heartbeatIntervalSeconds,
      postIntervalHours: config.postIntervalHours,
    };
    this.deps = {
      now: Date.now,
      loadContext: loadAgentContext,
      sendHeartbeat,
      getNextTickAt,
      generateCrawlKeywords,
      runMediaCrawler,
      ingestCrawlerResults,
      buildScheduledInput: buildLocalScheduledAgentInput,
      ...options.deps,
    };
  }

  getStats(): AgentStats {
    return {
      startedAt: this.startedAt,
      totalRuns: this.totalRuns,
      successfulRuns: this.successfulRuns,
      failedRuns: this.failedRuns,
      lastRunAt: this.lastRunAt,
      lastRunOk: this.lastRunOk,
    };
  }

  async tick() {
    const now = this.deps.now();
    const actorId = this.getActorId();

    if (now - this.lastHeartbeatAt >= this.timings.heartbeatIntervalSeconds * 1000) {
      await this.deps.sendHeartbeat(actorId);
      this.lastHeartbeatAt = now;
      console.log('[local-agent] heartbeat sent');
    }

    const nextTickAt = await this.deps.getNextTickAt(actorId);
    if (nextTickAt && nextTickAt.getTime() > now) {
      return;
    }
    if (!nextTickAt && now - this.lastPostAt < this.timings.postIntervalHours * 3600 * 1000) {
      return;
    }

    await this.runScheduledPost(now, actorId);
  }

  private async runScheduledPost(now: number, actorId: string) {
    const initialCtx = await this.deps.loadContext(actorId);
    const recentTopics = initialCtx.context.recentDaily
      .slice(0, 5)
      .map((p) => p.topic)
      .filter((t): t is string => Boolean(t));
    const crawlKeywords = await this.deps.generateCrawlKeywords({
      pet: {
        name: initialCtx.pet.name,
        personality: initialCtx.pet.personality ?? null,
        species: initialCtx.pet.species ?? null,
      },
      recentTopics,
      today: initialCtx.context.today,
    });

    try {
      await this.getHooks()?.beforeCrawl();
      await this.deps.runMediaCrawler({ keywords: crawlKeywords, maxCount: 10 });
      await this.deps.ingestCrawlerResults(10);
    } catch (err) {
      console.warn('[local-agent] crawler failed, continuing with existing trends:', err instanceof Error ? err.message : err);
    }

    console.log('[local-agent] loading context...');
    const ctx = await this.deps.loadContext(actorId);
    console.log(`[local-agent] pet: ${ctx.pet.name}, trends: ${ctx.context.trendItems.length}`);

    console.log('[local-agent] running agent...');
    this.totalRuns++;
    this.lastRunAt = new Date().toISOString();
    try {
      const setup = this.buildSetup(ctx);
      const state = await this.graphService.invokeState(setup);
      const result = await readLatestStructuredCapabilityResult({
        state,
        schema: dailyPostResultSchema,
        readArtifact: this.readCapabilityArtifact,
        threadId: setup.input.threadId,
      });
      const dailyPostResult: DailyPostResult = result
        ? result as DailyPostResult
        : { status: 'skipped', postId: null, reason: 'no-post', payload: null, imageRequested: false };
      console.log(`[local-agent] result: ${dailyPostResult.status}${dailyPostResult.postId ? ` post=${dailyPostResult.postId}` : ''}${dailyPostResult.reason ? ` reason=${dailyPostResult.reason}` : ''}`);
      this.lastPostAt = now;
      this.successfulRuns++;
      this.lastRunOk = true;
      if (dailyPostResult.status === 'created' && dailyPostResult.postId && dailyPostResult.payload) {
        await this.getHooks()?.afterPostSaved(dailyPostResult.postId, dailyPostResult.payload);
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

  private buildSetup(ctx: AgentContext): AgentChannelSetup {
    return this.deps.buildScheduledInput({
      context: ctx,
      llmConfig: this.getLlmConfig() ?? buildLocalLlmConfig(),
      dryRun: false,
      toolkits: this.getLocalToolkits(),
      userCapabilities: this.getUserCapabilities(),
    });
  }
}
