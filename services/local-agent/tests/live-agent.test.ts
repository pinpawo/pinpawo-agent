import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { HumanMessage } from '@langchain/core/messages';
import {
  createOrchestratorGraph,
  type AgentActor,
  type OrchestratorStateType,
} from '@pinpawo/pet-agent';
import { buildLocalAgentModels } from '../src/agentModels';
import type { AgentLlmConfig } from '../src/agentConfig';
import { loadStoredConfig } from '../src/storage';
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
      'Missing LLM_API_KEY. Set it in services/local-agent/.env or run pinpawo login first.',
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
