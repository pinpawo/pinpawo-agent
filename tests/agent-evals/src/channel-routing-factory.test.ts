import assert from 'node:assert/strict';
import test from 'node:test';
import { createChannelRouter, createLlmRouteDecider, type RouteInput } from '../../../plugins/channel/src/channelRouting.ts';
import { buildModel } from '../../../services/host/src/agent/agentModels.ts';
import { AnthropicCompatibleChatModel } from '../../../services/host/src/agent/anthropicCompatibleChatModel.ts';
import { ReasoningPassbackCompletions } from '../../../services/host/src/agent/reasoningPassback.ts';

const input: RouteInput = {
  channel: { title: 'Release' }, message: { author: 'Barry', body: 'Who is handling #1003?' },
  pets: [{ participantId: 'pet:executor', name: 'Executor' }, { participantId: 'pet:reviewer', name: 'Reviewer' }],
  history: [{ author: 'Executor', body: 'Opened #1003.' }],
};
const endpoint = { profileId: 'p', baseUrl: 'https://models.test/v1/', apiKey: 'k', model: 'small' };

type Method = 'functionCalling' | 'jsonMode' | 'jsonSchema';
const decision = { target: 'pet:executor', confidence: 0.8, reason: 'It opened #1003.' };
const openAIReply = (method: Method, value: unknown = decision) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const message = method === 'functionCalling'
    ? { role: 'assistant', content: null, tool_calls: [{ id: 'tool_1', type: 'function', function: { name: 'channel_route', arguments: text } }] }
    : { role: 'assistant', content: text };
  return { id: 'mock', object: 'chat.completion', created: 0, model: 'small',
    choices: [{ index: 0, message, finish_reason: method === 'functionCalling' ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
};

function modelEndpoint(protocol: 'openai-compatible' | 'anthropic-compatible', fetcher: typeof fetch, method?: Method, modelName = endpoint.model) {
  return {
    ...endpoint, protocol,
    structuredOutputMethod: method ?? 'jsonMode' as const,
    createChatModel: (options: { maxOutputTokens: number; maxRetries: number; preferDeterministic: boolean; streaming?: boolean; forceChatCompletions?: boolean }) => {
      assert.deepEqual(options, { maxOutputTokens: 300, maxRetries: 0, preferDeterministic: true, streaming: false, forceChatCompletions: true });
      const model = buildModel({ protocol, apiKey: endpoint.apiKey,
        baseUrl: protocol === 'anthropic-compatible' ? 'https://models.test' : endpoint.baseUrl,
        model: modelName, maxOutputTokens: options.maxOutputTokens, maxRetries: options.maxRetries,
        ...(method ? { structuredOutputMethod: method } : {}) }, { preferDeterministic: options.preferDeterministic, streaming: options.streaming, forceChatCompletions: options.forceChatCompletions });
      if (model instanceof AnthropicCompatibleChatModel) model.clientOptions.fetch = fetcher;
      else if (model instanceof ReasoningPassbackCompletions) model.clientConfig.fetch = fetcher;
      else (model as unknown as { completions: ReasoningPassbackCompletions }).completions.clientConfig.fetch = fetcher;
      return model;
    },
  };
}

for (const method of ['jsonSchema', 'jsonMode', 'functionCalling'] as const) {
  test(`routing preserves OpenAI-compatible ${method} requests through the Host factory`, async () => {
    let sent = false;
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      sent = true;
      assert.equal(String(url), 'https://models.test/v1/chat/completions');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer k');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'small');
      assert.equal(body.temperature, 0);
      assert.equal(body.max_tokens, 300);
      assert.equal(body.max_completion_tokens, undefined);
      const user = JSON.parse(body.messages[1].content);
      assert.deepEqual(user.targets, ['pet:executor', 'pet:reviewer', 'none']);
      if (method === 'jsonSchema') {
        assert.equal(body.response_format.type, 'json_schema');
        assert.equal(body.response_format.json_schema.strict, true);
        assert.deepEqual(body.response_format.json_schema.schema.required, ['target', 'confidence', 'reason']);
        assert.deepEqual(body.response_format.json_schema.schema.properties.target.enum, user.targets);
      } else if (method === 'jsonMode') {
        assert.equal(body.response_format.type, 'json_object');
      } else {
        assert.equal(body.tool_choice.function.name, 'channel_route');
        assert.deepEqual(body.tools[0].function.parameters.properties.target.enum, user.targets);
      }
      return Response.json(openAIReply(method));
    }) as typeof fetch;
    const result = await createLlmRouteDecider(modelEndpoint('openai-compatible', fake, method))(input, AbortSignal.timeout(1_000));
    assert.deepEqual(result, decision);
    assert.equal(sent, true);
  });
}

test('jsonMode routing accepts a decision without the optional reason', async () => {
  const value = { target: 'pet:executor', confidence: 0.8 };
  const fetcher = (async () => Response.json(openAIReply('jsonMode', value))) as typeof fetch;
  const result = await createLlmRouteDecider(modelEndpoint('openai-compatible', fetcher, 'jsonMode'))(input, AbortSignal.timeout(1_000));
  assert.deepEqual(result, value);
});

test('routing remains non-streaming even for an OpenAI-compatible model that usually streams', async () => {
  let sent = false;
  const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent = true;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'glm-4.5');
    assert.notEqual(body.stream, true);
    assert.equal(body.max_tokens, 300);
    assert.equal(body.max_completion_tokens, undefined);
    assert.equal(body.temperature, 0);
    return Response.json(openAIReply('jsonMode'));
  }) as typeof fetch;
  const result = await createLlmRouteDecider(modelEndpoint('openai-compatible', fake, 'jsonMode', 'glm-4.5'))(input, AbortSignal.timeout(1_000));
  assert.deepEqual(result, decision);
  assert.equal(sent, true);
});

for (const modelName of ['codex-gateway', 'gpt-5.5-pro', 'o3']) {
  test(`routing uses chat completions for ${modelName}`, async () => {
    let sent = false;
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      sent = true;
      assert.equal(String(url), 'https://models.test/v1/chat/completions');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, modelName);
      assert.equal(body.messages[0].role, 'system');
      assert.equal(body.messages[1].role, 'user');
      assert.equal(body.max_tokens, 300);
      assert.equal(body.max_completion_tokens, undefined);
      assert.notEqual(body.stream, true);
      assert.equal(body.response_format.type, 'json_object');
      return Response.json(openAIReply('jsonMode'));
    }) as typeof fetch;
    const result = await createLlmRouteDecider(modelEndpoint('openai-compatible', fake, 'jsonMode', modelName))(input, AbortSignal.timeout(1_000));
    assert.deepEqual(result, decision);
    assert.equal(sent, true);
  });
}

test('routing uses native Anthropic Messages with the same decision semantics', async () => {
  let sent = false;
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    sent = true;
    assert.equal(String(url), 'https://models.test/v1/messages');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-api-key'), 'k');
    assert.equal(headers.has('authorization'), false);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.max_tokens, 300);
    assert.equal(body.temperature, undefined);
    assert.equal(body.thinking, undefined);
    assert.equal(body.tool_choice.type, 'tool');
    assert.equal(body.tool_choice.name, 'channel_route');
    assert.deepEqual(body.tools[0].input_schema.properties.target.enum, ['pet:executor', 'pet:reviewer', 'none']);
    return Response.json({ id: 'msg_mock', type: 'message', role: 'assistant', model: 'small',
      content: [{ type: 'tool_use', id: 'tool_1', name: 'channel_route', input: decision }],
      stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  }) as typeof fetch;
  const result = await createLlmRouteDecider(modelEndpoint('anthropic-compatible', fake, 'functionCalling'))(input, AbortSignal.timeout(1_000));
  assert.deepEqual(result, decision);
  assert.equal(sent, true);
});

test('routing supports native Anthropic JSON Schema without forcing tool choice', async () => {
  let calls = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    assert.equal(String(url), 'https://models.test/v1/messages');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.output_config.format.type, 'json_schema');
    const target = body.output_config.format.schema.properties.target;
    assert.equal(target.type, 'string');
    for (const value of ['pet:executor', 'pet:reviewer', 'none']) assert.ok(target.description.includes(JSON.stringify(value)));
    assert.equal(body.tools, undefined);
    assert.equal(body.tool_choice, undefined);
    return Response.json({ id: 'msg_mock', type: 'message', role: 'assistant', model: 'small',
      content: [{ type: 'text', text: JSON.stringify(decision) }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  }) as typeof fetch;
  const result = await createLlmRouteDecider(modelEndpoint('anthropic-compatible', fetcher, 'jsonSchema'))(input, AbortSignal.timeout(1_000));
  assert.deepEqual(result, decision);
  assert.equal(calls, 1);
});

test('routing needs a model factory and preserves configured error handling', async () => {
  assert.throws(() => createLlmRouteDecider(endpoint), /createChatModel/);
  let constructed = false;
  assert.equal(createChannelRouter({ enabled: false }, { resolveModel: () => ({ ...endpoint,
    createChatModel: () => { constructed = true; throw new Error('unused'); } }) }), undefined);
  assert.equal(constructed, false);
  const bad = (value: unknown, status = 200) => (async () => status === 200
    ? Response.json(openAIReply('jsonMode', value))
    : Response.json({ error: { message: 'mock failure', type: 'invalid_request_error' } }, { status })) as typeof fetch;
  await assert.rejects(createLlmRouteDecider(modelEndpoint('openai-compatible', bad('{}', 500)))(input, AbortSignal.timeout(1_000)), /500/);
  await assert.rejects(createLlmRouteDecider(modelEndpoint('openai-compatible', bad('not json')))(input, AbortSignal.timeout(1_000)));
  await assert.rejects(createLlmRouteDecider(modelEndpoint('openai-compatible', bad({ target: 'none', confidence: 2 })))(input, AbortSignal.timeout(1_000)));
  const router = createChannelRouter({ enabled: true }, { resolveModel: () => modelEndpoint('openai-compatible', bad('{}', 500)) })!;
  const outcome = await router.decide(input);
  assert.deepEqual(outcome, { kind: 'skip', reason: 'error', detail: 'Routing model returned HTTP 500.' });
});

test('malformed function arguments never expose model output through a routing outcome', async () => {
  const secret = 'PRIVATE_MODEL_OUTPUT_MARKER';
  const fetcher = (async () => Response.json(openAIReply('functionCalling', `{"target":"${secret}`))) as typeof fetch;
  const router = createChannelRouter({ enabled: true }, {
    resolveModel: () => modelEndpoint('openai-compatible', fetcher, 'functionCalling'),
  })!;
  const outcome = await router.decide(input);
  assert.deepEqual(outcome, { kind: 'skip', reason: 'error', detail: 'Routing model request failed.' });
  assert.doesNotMatch(JSON.stringify(outcome), /PRIVATE_MODEL_OUTPUT_MARKER/);
});

test('provider error response text is not returned in the routing outcome', async () => {
  const fetcher = (async () => Response.json({ error: { message: 'PRIVATE_SERVER_ERROR', type: 'invalid_request_error' } }, { status: 500 })) as typeof fetch;
  const router = createChannelRouter({ enabled: true }, { resolveModel: () => modelEndpoint('openai-compatible', fetcher, 'jsonMode') })!;
  const outcome = await router.decide(input);
  assert.deepEqual(outcome, { kind: 'skip', reason: 'error', detail: 'Routing model returned HTTP 500.' });
  assert.doesNotMatch(JSON.stringify(outcome), /PRIVATE_SERVER_ERROR/);
});

test('routing propagates cancellation to OpenAI and Anthropic requests', async () => {
  for (const protocol of ['openai-compatible', 'anthropic-compatible'] as const) {
    const controller = new AbortController();
    let started = false;
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      started = true;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        controller.abort();
      });
    }) as typeof fetch;
    const method = protocol === 'anthropic-compatible' ? 'functionCalling' : 'jsonMode';
    await assert.rejects(createLlmRouteDecider(modelEndpoint(protocol, fetcher, method))(input, controller.signal), /abort/i);
    assert.equal(started, true);
  }
});
