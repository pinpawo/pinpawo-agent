import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLocalAgentModels } from './agentModels';
import { buildDecisionStructuredOutput } from './agentChannel';
import { createLocalModelProfileRegistry } from './llmConfig';
import { buildModelProfileRegistry } from './modelProfiles';
import { resolveGlobalReviewBatchPolicy } from '../../../packages/pet-agent/src/agent/orchestrator/review/globalReviewPolicy';
import { buildReviewSpec } from '../../../packages/pet-agent/src/agent/orchestrator/review/reviewSpec';

function registry(model: string, sourcePreset?: string, baseUrl = 'https://api.deepseek.com') {
  return createLocalModelProfileRegistry({
    snapshot: buildModelProfileRegistry({
      env: {},
      stored: {
        models: {
          version: 1,
          defaultProfileId: 'review',
          profiles: {
            review: {
              id: 'review', label: 'Review', provider: 'deepseek', sourcePreset,
              model, baseUrl, apiKey: 'test-key', contextWindowTokens: 1_000_000,
              inputModalities: ['text'], structuredOutputMethod: 'functionCalling',
            },
          },
        },
      },
    }),
    llmDefaults: { maxRetries: 0 },
  });
}

test('DeepSeek auto review migrates saved profiles and sends JSON without forced tools', async (t) => {
  const tracing = process.env.LANGSMITH_TRACING;
  const legacyTracing = process.env.LANGCHAIN_TRACING_V2;
  process.env.LANGSMITH_TRACING = 'false';
  process.env.LANGCHAIN_TRACING_V2 = 'false';
  t.after(() => {
    if (tracing === undefined) delete process.env.LANGSMITH_TRACING;
    else process.env.LANGSMITH_TRACING = tracing;
    if (legacyTracing === undefined) delete process.env.LANGCHAIN_TRACING_V2;
    else process.env.LANGCHAIN_TRACING_V2 = legacyTracing;
  });
  const requests: Record<string, unknown>[] = [];
  let output = { riskScore: 1, reason: 'Bounded local operation.' };
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({
      id: 'review-test', object: 'chat.completion', created: 0,
      model: 'deepseek-v4-flash-vision-exp',
      choices: [{ index: 0, finish_reason: 'stop', message: {
        role: 'assistant', content: JSON.stringify(output),
      } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }), { headers: { 'Content-Type': 'application/json' } });
  });

  for (const [model, preset] of [
    ['deepseek-v4-pro', 'deepseek'],
    ['deepseek-v4-flash', 'deepseek-flash'],
    ['deepseek-v4-flash-vision-exp', 'deepseek-flash-vision'],
  ]) {
    const profiles = registry(model!, preset!);
    const config = profiles.resolve();
    assert.equal(config.structuredOutputMethod, 'jsonMode');
    assert.equal(profiles.snapshot.profiles.review?.structuredOutputMethod, 'functionCalling');
    const options = {
      policy: { mode: 'auto_authorization' as const, structuredOutput: buildDecisionStructuredOutput(config) },
      models: buildLocalAgentModels(config),
      messages: [], workdir: '/repo',
      reviews: [{
        toolkitName: 'bash', toolName: 'write_file', input: { path: '/repo/note.txt' },
        review: buildReviewSpec({
          view: { kind: 'plain', title: 'Write file', body: 'Write /repo/note.txt' }, options: [],
        }),
      }],
    };
    output = { riskScore: 1, reason: 'Bounded local operation.' };
    assert.equal((await resolveGlobalReviewBatchPolicy(options)).type, 'authorize');
    output = { riskScore: 10, reason: 'Requires human authorization.' };
    assert.equal((await resolveGlobalReviewBatchPolicy(options)).type, 'require_authorization');
    output = { riskScore: 99, reason: 'Invalid assessment.' };
    assert.equal((await resolveGlobalReviewBatchPolicy(options)).type, 'require_authorization');
  }
  assert.ok(requests.length >= 9);
  for (const request of requests) {
    assert.deepEqual(request.response_format, { type: 'json_object' });
    assert.equal(request.tool_choice, undefined);
    assert.equal(request.tools, undefined);
    assert.equal(request.thinking, undefined);
  }
});

test('DeepSeek compatibility preserves custom and third-party structured-output choices', () => {
  for (const profiles of [
    registry('deepseek-v4-flash'),
    registry('custom-model', 'deepseek-flash'),
    registry('deepseek-v4-flash', 'deepseek-flash', 'https://example.test/v1'),
  ]) {
    assert.equal(profiles.resolve().structuredOutputMethod, 'functionCalling');
  }
});
