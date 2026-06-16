import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { HumanMessage } from '@langchain/core/messages';
import {
  createOrchestratorGraph,
  type AgentActor,
  type OrchestratorStateType,
} from '@pinpawo/pet-agent';
import {
  createDailyPostCapability,
  dailyPostResultSchema,
  type DailyPostPayload,
  type TrendPromptItem,
} from '../src/capabilities/dailyPost';
import { buildLocalAgentModels } from '../src/agentModels';
import type { AgentLlmConfig } from '../src/agentConfig';
import { loadStoredConfig } from '../src/storage';
import { FileCapabilityArtifactStore } from '../src/capabilityArtifactStore';
import { createCapabilityArtifactToolkit } from '../src/toolkits/capabilityArtifact';
import { createPetProfileTool } from '../src/toolkits/petProfile';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(__dirname, '..');
const repoRoot = resolve(workspaceRoot, '..', '..');

function loadEnvFile(path: string) {
  if (!existsSync(path)) {
    return;
  }

  const content = readFileSync(path, 'utf-8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const eq = trimmed.indexOf('=');
    if (eq < 1) {
      continue;
    }

    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function loadLiveLlmConfig(): AgentLlmConfig {
  loadEnvFile(resolve(repoRoot, '.env'));
  loadEnvFile(resolve(workspaceRoot, '.env'));

  const stored = loadStoredConfig();
  const apiKey = process.env.LLM_API_KEY || stored.llm_api_key || '';
  if (!apiKey) {
    throw new Error(
      'Missing LLM_API_KEY. Set it in services/local-agent/.env or run pinpawo-agent login first.',
    );
  }

  return {
    apiKey,
    baseUrl:
      process.env.LLM_BASE_URL
      || stored.llm_base_url
      || 'https://api.deepseek.com',
    model: process.env.LLM_MODEL || stored.llm_model || 'deepseek-v4-pro',
    observeModel: process.env.LLM_OBSERVE_MODEL || stored.llm_observe_model || undefined,
    temperature: Number(process.env.LLM_TEMPERATURE ?? 0.4),
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 90000),
  };
}

function buildActor(): AgentActor {
  return {
    petId: 'pet-live-test',
    userId: 'user-live-test',
    name: '牛牛',
    personality: '稳重可靠，温和真诚，擅长总结热点并给出克制建议',
    stage: 'adult',
    species: 'cow',
  };
}

function buildTrendItems(): TrendPromptItem[] {
  return [
    {
      id: '11111111-1111-4111-8111-111111111111',
      platform: 'xiaohongshu',
      topic: '宁波周末亲子',
      title: '宁波周末亲子游 9 个地方一次看完',
      summary: '覆盖动物园、乐园、博物馆，信息完整，点赞和收藏都高，适合周末出行。',
      url: 'https://example.com/trend-1',
      score: 0.94,
      likedCount: 5600,
      imageUrls: null,
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      platform: 'xiaohongshu',
      topic: '理财推广',
      title: '3 天学会稳健理财',
      summary: '内容偏营销，广告感重，虽然热度高但不太适合宠物账号继续处理。',
      url: 'https://example.com/trend-2',
      score: 0.61,
      likedCount: 1800,
      imageUrls: null,
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      platform: 'xiaohongshu',
      topic: '春日露营',
      title: '春日露营装备清单',
      summary: '偏好物推荐，适合垂类穿搭和露营号，不如第一条通用。',
      url: 'https://example.com/trend-3',
      score: 0.73,
      likedCount: 2200,
      imageUrls: null,
    },
  ];
}

function createLiveFixture() {
  const llmConfig = loadLiveLlmConfig();
  return {
    models: buildLocalAgentModels(llmConfig),
    actor: buildActor(),
  };
}

test('live chat smoke: use shared pet profile tool', { timeout: 120_000 }, async () => {
  const { models, actor } = createLiveFixture();
  const graph = createOrchestratorGraph({ models });
  const state = await graph.invoke(
    {
      messages: [
        new HumanMessage('请先调用 describe_pet_profile 了解你自己，再用两句中文介绍你自己，不要输出 JSON。'),
      ],
    },
    {
      configurable: {
        actor,
        tools: [createPetProfileTool({ actor })],
      },
    },
  ) as OrchestratorStateType;

  const reply = typeof state.messages.at(-1)?.content === 'string'
    ? (state.messages.at(-1)!.content as string).trim()
    : '';
  assert.ok(reply.length > 0, 'reply should not be empty');
  assert.equal(state.capabilityArtifacts.length, 0, 'no capability should produce artifacts');
});

test('live chat smoke: route to daily_post and persist a post result', { timeout: 180_000 }, async () => {
  const { models, actor } = createLiveFixture();
  const savedPayloads: DailyPostPayload[] = [];

  const capabilities = [
    createDailyPostCapability({
      recentDaily: [],
      trendItems: buildTrendItems(),
      savePost: async (params) => {
        savedPayloads.push(params.payload);
        return { postId: 'live-test-post-1' };
      },
    }),
  ];
  const artifactStore = new FileCapabilityArtifactStore(await mkdtemp(resolve(tmpdir(), 'pinpawo-live-artifacts-')));
  const graph = createOrchestratorGraph({ models });
  const state = await graph.invoke(
    {
      messages: [
        new HumanMessage([
          '请为牛牛写一条简短动态。',
          '调用 finalize_post 完成保存。',
          '不要调用 skip_post，也不要输出 JSON。',
        ].join('\n')),
      ],
    },
    {
      configurable: {
        thread_id: 'live-daily-post',
        actor,
        capabilities,
        toolkits: [createCapabilityArtifactToolkit(artifactStore)],
      },
    },
  ) as OrchestratorStateType;

  const latestResultRef = [...state.capabilityArtifacts].reverse().find((ref) => ref.kind === 'result');
  const resultContent = latestResultRef ? (await artifactStore.readArtifact({ uri: latestResultRef.uri })).content : null;
  const dailyPostResult = resultContent
    ? dailyPostResultSchema.safeParse(JSON.parse(resultContent) as unknown)
    : null;
  assert.ok(dailyPostResult?.success, 'daily_post result should be parseable');
  assert.equal(dailyPostResult?.data?.status, 'created');
  assert.equal(dailyPostResult?.data?.postId, 'live-test-post-1');
  assert.equal(savedPayloads.length, 1);
  assert.ok(savedPayloads[0]?.content.trim().length > 0, 'saved payload content should not be empty');

  const reply = typeof state.messages.at(-1)?.content === 'string'
    ? (state.messages.at(-1)!.content as string).trim()
    : '';
  assert.ok(reply.length > 0, 'reply should not be empty');
});
