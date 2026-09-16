import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLocalAgentModels,
  resolveLlmGenerationReserveTokens,
} from './agentModels';

function readTemperature(model: unknown): number | undefined {
  return (model as { temperature?: number }).temperature;
}

function readMaxTokens(model: unknown): number | undefined {
  return (model as { maxTokens?: number }).maxTokens;
}

function readInvocationParams(model: unknown): Record<string, unknown> {
  const invocationParams = (model as {
    invocationParams?: () => Record<string, unknown>;
  }).invocationParams;
  assert.ok(invocationParams);
  return invocationParams.call(model);
}

test('model roles leave temperature to the provider', () => {
  const models = buildLocalAgentModels({
    apiKey: 'test-key',
    baseUrl: 'https://api.kimi.com/coding/v1',
    model: 'k3',
    observeModel: 'k3',
    contextWindowTokens: 1_048_576,
  });

  assert.equal(readTemperature(models.act), undefined);
  assert.equal(readTemperature(models.decision), undefined);
  assert.equal(readTemperature(models.answer), undefined);
  assert.equal(readTemperature(models.observe), undefined);
  assert.equal(readTemperature(models.subagent), undefined);
});

test('every runtime role leaves thinking and effort to the provider', () => {
  for (const model of ['deepseek-v4-pro', 'glm-5', 'qwen3.8-max', 'k3']) {
    const models = buildLocalAgentModels({ apiKey: 'test-key', baseUrl: 'https://example.test/v1', model });
    for (const instance of Object.values(models)) {
      const params = readInvocationParams(instance);
      assert.equal(params.thinking, undefined);
      assert.equal(params.enable_thinking, undefined);
      assert.equal(params.extra_body, undefined);
      assert.equal(params.reasoning_effort, undefined);
    }
  }
});

test('Qwen 3.8 roles preserve the provider-enforced thinking mode', () => {
  const models = buildLocalAgentModels({
    apiKey: 'test-key',
    baseUrl: 'https://workspace-id.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.8-max',
    maxOutputTokens: 131_072,
  });

  assert.equal(readInvocationParams(models.act).reasoning_effort, undefined);
  assert.equal(readInvocationParams(models.decision).reasoning_effort, undefined);
  assert.equal(readInvocationParams(models.answer).reasoning_effort, undefined);
  assert.equal(readInvocationParams(models.observe).reasoning_effort, undefined);
  assert.equal(readInvocationParams(models.subagent).reasoning_effort, undefined);
  assert.equal('extra_body' in readInvocationParams(models.act), false);
  assert.equal(readInvocationParams(models.act).max_tokens, 131_072);
  assert.equal(readMaxTokens(models.act), 131_072);
  assert.equal(readMaxTokens(models.decision), 131_072);
  assert.equal(readMaxTokens(models.answer), 131_072);
  assert.equal(readMaxTokens(models.observe), 131_072);
  assert.equal(readMaxTokens(models.subagent), 131_072);
});

test('generation reserve includes Qwen thinking and configured output budgets', () => {
  assert.equal(resolveLlmGenerationReserveTokens({
    model: 'qwen3.8-max',
    maxOutputTokens: 131_072,
  }), 147_456);
  assert.equal(resolveLlmGenerationReserveTokens({
    model: 'gpt-5.5',
    maxOutputTokens: 128_000,
  }), 128_000);
  assert.equal(resolveLlmGenerationReserveTokens({
    model: 'custom-model',
  }), undefined);
});
