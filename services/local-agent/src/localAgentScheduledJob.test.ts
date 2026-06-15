import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentChannelSetup } from './agentChannel';
import type { AgentContext } from './contextLoader';
import { LocalAgentScheduledJob } from './localAgentScheduledJob';

function createContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    pet: {
      id: 'pet-a',
      name: 'Pet A',
      personality: 'calm',
      species: 'sheep',
      stage: 'sprout',
      growth_value: 5,
      stage_asset_id: null,
    },
    context: {
      petMemoryText: 'memory',
      recentChatTurns: [],
      recentDaily: [
        { content: 'old 1', topic: 'topic-a', tags: null, created_at: '2026-06-01T00:00:00.000Z' },
        { content: 'old 2', topic: null, tags: null, created_at: '2026-06-01T00:00:00.000Z' },
        { content: 'old 3', topic: 'topic-b', tags: null, created_at: '2026-06-01T00:00:00.000Z' },
      ],
      trendItems: [],
      today: '2026-06-02',
    },
    ...overrides,
  };
}

function createSetup(): AgentChannelSetup {
  return {
    graphKey: 'scheduled:test',
    graphConfig: {} as AgentChannelSetup['graphConfig'],
    input: {} as AgentChannelSetup['input'],
  };
}

function createJob(overrides: {
  now?: () => number;
  getNextTickAt?: () => Promise<Date | null>;
  loadContext?: (actorId: string) => Promise<AgentContext>;
  invokeStructuredResult?: () => Promise<{ result: unknown }>;
  buildInputs?: Array<Record<string, unknown>>;
  hooksLog?: string[];
  heartbeatLog?: string[];
} = {}) {
  const buildInputs = overrides.buildInputs ?? [];
  const hooksLog = overrides.hooksLog ?? [];
  const heartbeatLog = overrides.heartbeatLog ?? [];
  const loadContext = overrides.loadContext ?? (async () => createContext());
  const job = new LocalAgentScheduledJob({
    graphService: ({
      invokeStructuredResult: overrides.invokeStructuredResult ?? (async () => ({
        result: {
          status: 'created',
          postId: 'post-1',
          reason: null,
          payload: { content: 'post' },
          imageRequested: false,
        },
      })),
    } as unknown) as ConstructorParameters<typeof LocalAgentScheduledJob>[0]['graphService'],
    getActorId: () => 'pet-a',
    getLlmConfig: () => ({
      provider: 'openai',
      model: 'test-model',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
    } as ConstructorParameters<typeof LocalAgentScheduledJob>[0]['getLlmConfig'] extends () => infer T ? T : never),
    getHooks: () => ({
      beforeCrawl: async () => {
        hooksLog.push('beforeCrawl');
      },
      afterPostSaved: async (postId) => {
        hooksLog.push(`afterPostSaved:${postId}`);
      },
    }),
    getLocalToolkits: () => [{ name: 'toolkit-a' }] as ConstructorParameters<typeof LocalAgentScheduledJob>[0]['getLocalToolkits'] extends () => infer T ? T : never,
    getLocalCapabilityToolkits: () => [{ name: 'capability-toolkit-a' }] as ConstructorParameters<typeof LocalAgentScheduledJob>[0]['getLocalCapabilityToolkits'] extends () => infer T ? T : never,
    getUserCapabilities: () => [{
      meta: { id: 'user-cap' },
      capability: { name: 'user-capability' },
    }] as ConstructorParameters<typeof LocalAgentScheduledJob>[0]['getUserCapabilities'] extends () => infer T ? T : never,
    timings: {
      heartbeatIntervalSeconds: 1,
      postIntervalHours: 1,
    },
    deps: {
      now: overrides.now ?? (() => 10_000_000),
      loadContext,
      sendHeartbeat: async (actorId) => {
        heartbeatLog.push(actorId);
      },
      getNextTickAt: overrides.getNextTickAt ?? (async () => null),
      generateCrawlKeywords: async (params) => {
        assert.deepEqual(params.recentTopics, ['topic-a', 'topic-b']);
        return ['keyword-a'];
      },
      runMediaCrawler: async (params) => {
        hooksLog.push(`crawler:${params.keywords.join(',')}:${params.maxCount ?? ''}`);
      },
      ingestCrawlerResults: async (maxCount) => {
        hooksLog.push(`ingest:${maxCount ?? ''}`);
      },
      buildScheduledInput: (params) => {
        buildInputs.push(params as unknown as Record<string, unknown>);
        return createSetup();
      },
    },
  });
  return { job, buildInputs, hooksLog, heartbeatLog };
}

test('LocalAgentScheduledJob sends heartbeat and skips post when next tick is in the future', async () => {
  let loadContextCalls = 0;
  const { job, heartbeatLog } = createJob({
    now: () => 2_000,
    getNextTickAt: async () => new Date(3_000),
    loadContext: async () => {
      loadContextCalls += 1;
      return createContext();
    },
  });

  await job.tick();

  assert.deepEqual(heartbeatLog, ['pet-a']);
  assert.equal(loadContextCalls, 0);
  const stats = job.getStats();
  assert.equal(typeof stats.startedAt, 'string');
  assert.equal(stats.totalRuns, 0);
  assert.equal(stats.successfulRuns, 0);
  assert.equal(stats.failedRuns, 0);
  assert.equal(stats.lastRunAt, null);
  assert.equal(stats.lastRunOk, null);
});

test('LocalAgentScheduledJob runs scheduled post and records successful stats', async () => {
  const loadContextActors: string[] = [];
  const { job, buildInputs, hooksLog, heartbeatLog } = createJob({
    loadContext: async (actorId) => {
      loadContextActors.push(actorId);
      return createContext();
    },
  });

  await job.tick();

  assert.deepEqual(heartbeatLog, ['pet-a']);
  assert.deepEqual(loadContextActors, ['pet-a', 'pet-a']);
  assert.deepEqual(hooksLog, [
    'beforeCrawl',
    'crawler:keyword-a:10',
    'ingest:10',
    'afterPostSaved:post-1',
  ]);
  assert.equal(buildInputs.length, 1);
  assert.equal(buildInputs[0]?.dryRun, false);
  assert.equal((buildInputs[0]?.toolkits as Array<{ name?: string }> | undefined)?.[0]?.name, 'toolkit-a');

  const stats = job.getStats();
  assert.equal(stats.totalRuns, 1);
  assert.equal(stats.successfulRuns, 1);
  assert.equal(stats.failedRuns, 0);
  assert.equal(stats.lastRunOk, true);
  assert.equal(typeof stats.lastRunAt, 'string');
});

test('LocalAgentScheduledJob treats 429 as successful backoff', async () => {
  const { job } = createJob({
    invokeStructuredResult: async () => {
      throw { status: 429 };
    },
  });

  await job.tick();

  const stats = job.getStats();
  assert.equal(stats.totalRuns, 1);
  assert.equal(stats.successfulRuns, 1);
  assert.equal(stats.failedRuns, 0);
  assert.equal(stats.lastRunOk, true);
});
