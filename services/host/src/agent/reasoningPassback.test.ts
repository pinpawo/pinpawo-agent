import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatOpenAI } from '@langchain/openai';
import { ChatModelStream } from '@langchain/core/language_models/stream';
import type { ChatModelStreamEvent } from '@langchain/core/language_models/event';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { readMessageTokenUsage } from '@pinpawo/pet-agent';
import { buildHostModel } from './agentModels';
import {
  buildCompletionsMessagesWithReasoning,
  normalizeCompletionsCacheUsage,
  type ReasoningPassbackCompletions,
} from './reasoningPassback';

type RequestBody = { stream?: boolean; tools?: unknown[]; messages: Array<Record<string, unknown>> };

function fakeProvider(requests: RequestBody[]): typeof fetch {
  return async (_url, init) => {
    const body: RequestBody = JSON.parse(String(init?.body));
    requests.push(body);
    const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 60 };
    const delta = {
      role: 'assistant', content: '', reasoning_content: 'need the weather',
      tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{}' } }],
    };
    if (body.stream) {
      const chunk = { id: 'r1', object: 'chat.completion.chunk', created: 0, model: 'deepseek-v4-pro',
        choices: [{ index: 0, delta, finish_reason: 'tool_calls' }], usage };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    const { tool_calls, ...message } = delta;
    return Response.json({
      id: 'r1', object: 'chat.completion', created: 0, model: 'deepseek-v4-pro', usage,
      choices: [{ index: 0, message: { ...message, tool_calls: tool_calls.map(({ index: _i, ...call }) => call) },
        finish_reason: 'tool_calls' }],
    });
  };
}

test('assistant reasoning is sent back from additional_kwargs and reasoning blocks', () => {
  const messages: BaseMessage[] = [
    new HumanMessage('hi'),
    new AIMessage({ content: '', additional_kwargs: { reasoning_content: 'kwargs reasoning' },
      tool_calls: [{ id: 'a', name: 'weather', args: {} }] }),
    new ToolMessage({ content: 'sunny', tool_call_id: 'a' }),
    new AIMessage({ content: [{ type: 'reasoning', reasoning: 'block ' }, { type: 'reasoning', reasoning: 'reasoning' }],
      tool_calls: [{ id: 'b', name: 'weather', args: {} }] }),
    new ToolMessage({ content: 'rainy', tool_call_id: 'b' }),
    new AIMessage('no reasoning'),
  ];
  const params = buildCompletionsMessagesWithReasoning(messages, 'deepseek-v4-pro');
  assert.equal(params.length, messages.length);
  assert.deepEqual(params.filter(param => param.role === 'assistant')
    .map(param => (param as { reasoning_content?: string }).reasoning_content),
  ['kwargs reasoning', 'block reasoning', undefined]);
  const original = params.map((param, index) => ({ ...param, vendor_extension: index }));
  const patched = buildCompletionsMessagesWithReasoning(messages, 'deepseek-v4-pro', { originalMessages: original });
  assert.deepEqual(patched.map(param => (param as { vendor_extension?: number }).vendor_extension), [0, 1, 2, 3, 4, 5]);
});

test('an ordinary request without reasoning uses the same wire body as the official adapter', async () => {
  const bodies: RequestBody[] = [];
  const baseUrl = 'https://provider.example.test/v1';
  const official = new ChatOpenAI({ apiKey: 'test-key', model: 'deepseek-v4-pro', maxRetries: 0,
    configuration: { baseURL: baseUrl, fetch: fakeProvider(bodies) } });
  const patched = buildHostModel({ apiKey: 'test-key', baseUrl, model: 'deepseek-v4-pro', maxRetries: 0 }, { streaming: false });
  (patched as unknown as { completions: ReasoningPassbackCompletions }).completions.clientConfig.fetch = fakeProvider(bodies);
  await official.invoke([new HumanMessage('hello')]);
  await patched.invoke([new HumanMessage('hello')]);
  assert.deepEqual(bodies[0], bodies[1]);
});

for (const mode of ['invoke', 'stream', 'v3'] as const) {
  for (const patched of [false, true]) {
    test(`tool history and cache usage with ${patched ? 'patch' : 'official adapter'} (${mode})`, async () => {
      const requests: RequestBody[] = [];
      const baseUrl = 'https://provider.example.test/v1';
      const act = patched
        ? buildHostModel({ apiKey: 'test-key', baseUrl, model: 'deepseek-v4-pro', maxRetries: 0 }, { streaming: false })
        : new ChatOpenAI({ apiKey: 'test-key', model: 'deepseek-v4-pro', maxRetries: 0,
          configuration: { baseURL: baseUrl, fetch: fakeProvider(requests) } });
      const completions = (act as unknown as { completions: ReasoningPassbackCompletions }).completions;
      completions.clientConfig.fetch = fakeProvider(requests);
      const bound = (act as ChatOpenAI).bindTools([{ type: 'function', function: {
        name: 'weather', description: 'Get weather', parameters: { type: 'object', properties: {} },
      } }]);
      const history: BaseMessage[] = [new HumanMessage('weather?')];
      const run = async () => mode === 'stream'
        ? await (async () => {
          let merged;
          for await (const chunk of await bound.stream(history)) merged = merged ? merged.concat(chunk) : chunk;
          return new AIMessage({ ...merged! });
        })()
        : mode === 'v3'
          ? await new ChatModelStream(bound.streamEvents(history, { version: 'v3' } as never) as unknown as AsyncIterable<ChatModelStreamEvent>)
          : await bound.invoke(history);
      const first = await run();
      assert.equal(first.tool_calls?.length, 1);
      assert.equal(readMessageTokenUsage(first)?.cachedInputTokens, patched || mode !== 'stream' ? 60 : undefined);
      assert.equal(readMessageTokenUsage(first)?.totalTokens, 120);
      history.push(first, new ToolMessage({ content: 'sunny', tool_call_id: 'call_1' }));
      await run();
      assert.equal(requests.length, 2);
      assert.equal(requests[0]!.tools?.length, 1);
      assert.equal(requests[1]!.tools?.length, 1);
      assert.deepEqual(requests[1]!.messages.filter(message => message.role === 'assistant')
        .map(message => message.reasoning_content), [patched ? 'need the weather' : undefined]);
    });
  }
}

test('DeepSeek cache hits survive the OpenAI adapter boundary without inventing unknown zeros', () => {
  assert.deepEqual(normalizeCompletionsCacheUsage({ usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 60 } }), {
    usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 60, prompt_tokens_details: { cached_tokens: 60 } },
  });
  const unknown = { usage: { prompt_tokens: 100 } };
  assert.equal(normalizeCompletionsCacheUsage(unknown), unknown);
  const standard = { usage: { prompt_cache_hit_tokens: 60, prompt_tokens_details: { cached_tokens: 0 } } };
  assert.equal(normalizeCompletionsCacheUsage(standard), standard);
  const invalid = { usage: { prompt_cache_hit_tokens: -1 } };
  assert.equal(normalizeCompletionsCacheUsage(invalid), invalid);
});
