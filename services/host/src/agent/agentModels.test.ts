import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, ChatMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { AnthropicCompatibleChatModel } from './anthropicCompatibleChatModel';
import { ReasoningPassbackCompletions } from './reasoningPassback';
import {
  buildHostModel,
  buildHostModels,
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
  const models = buildHostModels({
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
    const models = buildHostModels({ apiKey: 'test-key', baseUrl: 'https://example.test/v1', model });
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
  const models = buildHostModels({
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

test('all roles use the same native Messages settings and observe uses its configured model', async () => {
  const config = {
    protocol: 'anthropic-compatible' as const,
    apiKey: 'mock-key', baseUrl: 'https://native.example.test',
    model: 'claude-sonnet-4-6', observeModel: 'claude-haiku-4-5',
    timeoutMs: 18_000, maxRetries: 0, maxOutputTokens: 1234,
  };
  const roles = buildHostModels(config, { preferDeterministic: true, streaming: false });
  assert.equal(new Set(Object.values(roles)).size, 5);
  for (const [role, instance] of Object.entries(roles)) {
    assert.ok(instance instanceof AnthropicCompatibleChatModel);
    assert.equal(instance.clientOptions.timeout, 18_000);
    let called = false;
    instance.clientOptions.fetch = async (url, init) => {
      called = true;
      assert.equal(String(url), 'https://native.example.test/v1/messages');
      assert.equal(new Headers(init?.headers).get('x-api-key'), 'mock-key');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, role === 'observe' ? 'claude-haiku-4-5' : 'claude-sonnet-4-6');
      assert.equal(body.max_tokens, 1234);
      assert.equal(body.thinking, undefined);
      assert.equal(body.temperature, undefined);
      assert.equal(body.stream, false);
      return Response.json({ id: 'msg_mock', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } });
    };
    assert.equal((await instance.invoke('Hi')).text, 'ok');
    assert.equal(called, true);
  }
});

test('all roles preserve OpenAI-compatible gateway requests, including an observe override', async () => {
  const roles = buildHostModels({
    apiKey: 'mock-key', baseUrl: 'https://gateway.example.test/v1', model: 'claude-gateway',
    observeModel: 'observer-gateway', timeoutMs: 18_000, maxRetries: 0, maxOutputTokens: 1234,
  }, { preferDeterministic: true, streaming: false });
  assert.equal(new Set(Object.values(roles)).size, 5);
  for (const [role, instance] of Object.entries(roles)) {
    assert.equal(instance instanceof AnthropicCompatibleChatModel, false);
    const completions = (instance as unknown as { completions: ReasoningPassbackCompletions }).completions;
    let called = false;
    completions.clientConfig.fetch = async (url, init) => {
      called = true;
      assert.equal(String(url), 'https://gateway.example.test/v1/chat/completions');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer mock-key');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, role === 'observe' ? 'observer-gateway' : 'claude-gateway');
      assert.equal(body.max_tokens, 1234);
      assert.equal(body.temperature, 0);
      assert.equal(body.stream, false);
      return Response.json({ id: 'mock', object: 'chat.completion', created: 0, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    };
    assert.equal((await instance.invoke('Hi')).text, 'ok');
    assert.equal(called, true);
  }
});


test('explicit generation temperature wins over deterministic preference on both protocols', () => {
  for (const protocol of ['openai-compatible', 'anthropic-compatible'] as const) {
    const model = buildHostModel({
      protocol, apiKey: 'mock-key', baseUrl: 'https://models.example.test', model: 'claude-sonnet-4-5',
    }, { preferDeterministic: true, temperature: 0.7 });
    assert.equal(readInvocationParams(model).temperature, 0.7);
  }
});

test('single-model streaming override preserves role defaults and supports explicit non-streaming', () => {
  const config = { apiKey: 'mock-key', baseUrl: 'https://gateway.example.test/v1', model: 'glm-4.5' };
  const roles = buildHostModels(config);
  for (const model of Object.values(roles)) assert.equal(readInvocationParams(model).stream, true);
  assert.equal(readInvocationParams(buildHostModel(config, { streaming: false })).stream, false);
  assert.equal(readInvocationParams(buildHostModel(config, { streaming: true })).stream, true);

  const native = { ...config, protocol: 'anthropic-compatible' as const };
  assert.equal(readInvocationParams(buildHostModel(native)).stream, false);
  assert.equal(readInvocationParams(buildHostModel(native, { streaming: false })).stream, false);
  assert.equal(readInvocationParams(buildHostModel(native, { streaming: true })).stream, true);
});

test('Chat Completions override keeps response-preferring gateway models on the existing wire protocol', async () => {
  for (const modelName of ['gpt-5.5-pro', 'gpt-5.6-codex', 'o3']) {
    const instance = buildHostModel({
      apiKey: 'mock-key', baseUrl: 'https://gateway.example.test/v1', model: modelName,
      timeoutMs: 18_000, maxRetries: 0, maxOutputTokens: 300,
    }, { forceChatCompletions: true, streaming: false, preferDeterministic: true });
    assert.ok(instance instanceof ReasoningPassbackCompletions);
    assert.equal(instance.timeout, 18_000);
    let called = 0;
    instance.clientConfig.fetch = async (url, init) => {
      called++;
      assert.equal(String(url), 'https://gateway.example.test/v1/chat/completions');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer mock-key');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, modelName);
      assert.equal(body.stream, false);
      assert.equal(body.max_tokens, 300);
      assert.equal(body.max_completion_tokens, undefined);
      assert.equal(body.messages[0].role, 'system');
      assert.equal(body.messages[2].role, 'developer');
      assert.equal(body.messages[3].reasoning_content, 'private reasoning');
      assert.equal(body.messages[4].tool_call_id, 'prior-call');
      assert.equal(body.temperature, 0);
      assert.equal(body.response_format.type, 'json_schema');
      assert.equal(body.response_format.json_schema.strict, true);
      return Response.json({ id: 'mock', object: 'chat.completion', created: 0, model: modelName,
        choices: [{ index: 0, message: { role: 'assistant', content: '{"value":"ok"}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    };
    const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false };
    const output = await instance.withStructuredOutput(schema, { name: 'response', method: 'jsonSchema', strict: true }).invoke([
      new SystemMessage('Follow the system policy'),
      new HumanMessage('Hi'),
      new ChatMessage({ role: 'developer', content: 'Developer instruction' }),
      new AIMessage({ content: '', tool_calls: [{ id: 'prior-call', name: 'lookup', args: {} }],
        additional_kwargs: { reasoning_content: 'private reasoning' } }),
      new ToolMessage({ content: 'found', tool_call_id: 'prior-call' }),
    ]);
    assert.deepEqual(output, { value: 'ok' });
    assert.equal(called, 1);
  }
});

test('ordinary role still uses the OpenAI wrapper and its Responses routing', async () => {
  const models = buildHostModels({
    apiKey: 'mock-key', baseUrl: 'https://gateway.example.test/v1', model: 'gpt-5.5-pro', maxRetries: 0,
  });
  assert.ok(models.act instanceof ChatOpenAI);
  const responses = (models.act as unknown as { responses: { clientConfig: { fetch: typeof fetch } } }).responses;
  let called = 0;
  responses.clientConfig.fetch = async (url) => {
    called++;
    assert.equal(String(url), 'https://gateway.example.test/v1/responses');
    return Response.json({ id: 'mock', object: 'response', created_at: 0, status: 'completed', model: 'gpt-5.5-pro',
      output: [{ id: 'message', type: 'message', status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', text: 'ok', annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  };
  assert.equal((await models.act.invoke('Hi')).text, 'ok');
  assert.equal(called, 1);
});


test('ordinary OpenAI role keeps SDK system-to-developer behavior for reasoning models', async () => {
  const model = buildHostModel({ apiKey: 'mock-key', baseUrl: 'https://gateway.example.test/v1',
    model: 'o3', maxRetries: 0 }, { streaming: false });
  assert.ok(model instanceof ChatOpenAI);
  const completions = (model as unknown as { completions: ReasoningPassbackCompletions }).completions;
  let requested = false;
  completions.clientConfig.fetch = async (_url, init) => {
    requested = true;
    assert.equal(JSON.parse(String(init?.body)).messages[0].role, 'developer');
    return Response.json({ id: 'mock', object: 'chat.completion', created: 0, model: 'o3',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  };
  assert.equal((await model.invoke([new SystemMessage('Policy'), new HumanMessage('Hi')])).text, 'ok');
  assert.equal(requested, true);
});
