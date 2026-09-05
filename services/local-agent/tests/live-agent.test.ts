import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { HumanMessage } from '@langchain/core/messages';
import {
  createOrchestratorGraph,
  runAgent,
  definePetDocument,
  petDocumentSystemPromptSection,
} from '@pinpawo/pet-agent';
import { buildLocalAgentModels } from '../src/agentModels';
import type { AgentLlmConfig } from '../src/agentConfig';
import { loadStoredConfig } from '../src/storage';

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
      'Missing LLM_API_KEY. Set it in services/local-agent/.env first.',
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

test('live chat smoke: authored PET.md identity', { timeout: 120_000 }, async () => {
  const models = buildLocalAgentModels(loadLiveLlmConfig());
  const graph = createOrchestratorGraph({ models });
  const document = definePetDocument({ content: '你叫牛牛，是一位温和真诚、擅长总结的助手。' });
  const result = await runAgent(graph, {
    messages: [new HumanMessage('请用两句中文介绍你自己，不要输出 JSON。')],
    context: { systemPromptSections: [petDocumentSystemPromptSection(document)] },
  });
  assert.ok(result.reply.length > 0, 'reply should not be empty');
});
