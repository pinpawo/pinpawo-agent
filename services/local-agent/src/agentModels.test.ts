import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLocalAgentModels } from './agentModels';

function readTemperature(model: unknown): number | undefined {
  return (model as { temperature?: number }).temperature;
}

function readModelKwargs(model: unknown): Record<string, unknown> | undefined {
  return (model as { modelKwargs?: Record<string, unknown> }).modelKwargs;
}

function readMaxTokens(model: unknown): number | undefined {
  return (model as { maxTokens?: number }).maxTokens;
}

function readBoundToolChoice(model: unknown, toolChoice: unknown): unknown {
  const bindTools = (model as {
    bindTools?: (
      tools: unknown[],
      options?: Record<string, unknown>,
    ) => unknown;
  }).bindTools;
  assert.ok(bindTools);
  const bound = bindTools.call(model, [], { tool_choice: toolChoice });
  return (bound as {
    defaultOptions?: Record<string, unknown>;
  }).defaultOptions?.tool_choice;
}

test('models use the provider temperature default when no override is configured', () => {
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

test('an explicit temperature override applies consistently to every role', () => {
  const models = buildLocalAgentModels({
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1',
    model: 'custom-model',
    observeModel: 'custom-model',
    temperature: 0.2,
  });

  assert.equal(readTemperature(models.act), 0.2);
  assert.equal(readTemperature(models.decision), 0.2);
  assert.equal(readTemperature(models.answer), 0.2);
  assert.equal(readTemperature(models.observe), 0.2);
  assert.equal(readTemperature(models.subagent), 0.2);
});

test('DeepSeek model roles apply the node-level thinking policy', () => {
  const models = buildLocalAgentModels({
    apiKey: 'test-key',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    observeModel: 'deepseek-v4-pro',
  });

  assert.deepEqual(readModelKwargs(models.act), {
    thinking: { type: 'disabled' },
  });
  assert.deepEqual(readModelKwargs(models.decision), {
    thinking: { type: 'disabled' },
  });
  assert.deepEqual(readModelKwargs(models.answer), {
    thinking: { type: 'enabled' },
  });
  assert.deepEqual(readModelKwargs(models.observe), {
    thinking: { type: 'disabled' },
  });
  assert.deepEqual(readModelKwargs(models.subagent), {
    thinking: { type: 'enabled' },
  });
  assert.equal(readMaxTokens(models.decision), undefined);
  assert.equal(readMaxTokens(models.act), undefined);
  assert.equal(readMaxTokens(models.answer), undefined);
});

test('an explicit subagent thinking override remains available', () => {
  const models = buildLocalAgentModels({
    apiKey: 'test-key',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    subagentThinking: false,
  });

  assert.deepEqual(readModelKwargs(models.subagent), {
    thinking: { type: 'disabled' },
  });
  assert.deepEqual(readModelKwargs(models.answer), {
    thinking: { type: 'enabled' },
  });
});

test('Qwen 3.8 roles preserve the provider-enforced thinking mode', () => {
  const models = buildLocalAgentModels({
    apiKey: 'test-key',
    baseUrl: 'https://workspace-id.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.8-max-preview',
  });

  assert.deepEqual(readModelKwargs(models.act), {});
  assert.deepEqual(readModelKwargs(models.decision), {});
  assert.deepEqual(readModelKwargs(models.answer), {});
  assert.deepEqual(readModelKwargs(models.observe), {});
  assert.deepEqual(readModelKwargs(models.subagent), {});
  assert.equal(readBoundToolChoice(models.act, 'any'), 'auto');
  assert.equal(readBoundToolChoice(models.act, 'required'), 'auto');
  assert.equal(readBoundToolChoice(models.act, 'submit_plan'), 'auto');
  assert.equal(readBoundToolChoice(models.act, {
    type: 'function',
    function: { name: 'submit_plan' },
  }), 'auto');
  assert.equal(readBoundToolChoice(models.act, 'none'), 'none');
  assert.equal(readBoundToolChoice(models.act, 'auto'), 'auto');
});

test('models with full tool-choice support preserve forced tool selection', () => {
  const models = buildLocalAgentModels({
    apiKey: 'test-key',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
  });

  assert.equal(readBoundToolChoice(models.act, 'any'), 'any');
});
