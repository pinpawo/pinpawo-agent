import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { buildHostModels } from './agentModels';
import { AnthropicCompatibleChatModel } from './anthropicCompatibleChatModel';

const config = { protocol: 'anthropic-compatible' as const, apiKey: 'mock-key', baseUrl: 'https://anthropic.example.test', model: 'claude-sonnet-4-5', maxRetries: 0, maxOutputTokens: 1024 };
const tool = { name: 'lookup', description: 'Look up a value', schema: z.object({ query: z.string() }) };
function response(content: unknown[], stop_reason = 'end_turn') {
  return { id: 'msg_mock', type: 'message', role: 'assistant', model: config.model, content, stop_reason, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 4 } };
}
function modelWithFetch(
  fetcher: NonNullable<AnthropicCompatibleChatModel['clientOptions']['fetch']>,
  structuredOutputMethod?: 'functionCalling' | 'jsonSchema' | 'jsonMode',
) {
  const model = buildHostModels({ ...config, structuredOutputMethod }).act;
  assert.ok(model instanceof AnthropicCompatibleChatModel);
  model.clientOptions.fetch = fetcher;
  return model;
}

test('explicit protocol selects all roles and leaves gateway Claude on OpenAI', () => {
  for (const model of Object.values(buildHostModels(config))) assert.ok(model instanceof AnthropicCompatibleChatModel);
  assert.equal(buildHostModels({ ...config, protocol: undefined }).act instanceof AnthropicCompatibleChatModel, false);
});

test('native SDK sends Messages auth, images and tool history, and preserves usage', async () => {
  let calls = 0;
  const model = modelWithFetch(async (url, init) => {
    calls++;
    assert.equal(String(url), `${config.baseUrl}/v1/messages`);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-api-key'), 'mock-key');
    assert.equal(headers.has('authorization'), false);
    const body = JSON.parse(String(init?.body));
    assert.equal('thinking' in body, false);
    assert.equal(body.max_tokens, 1024);
    assert.equal(body.parallel_tool_calls, undefined);
    assert.equal(body.tool_choice.disable_parallel_tool_use, true);
    assert.equal(body.messages[0].content[1].type, 'image');
    assert.equal(body.messages[1].content[0].type, 'tool_use');
    assert.equal(body.messages[2].content[0].type, 'tool_result');
    assert.equal(body.system, 'Be helpful');
    return Response.json(response([{ type: 'text', text: 'Found' }]));
  });
  // SDK 1.5.1 forwards the native object, but its tool_choice type omits
  // the supported `auto` object form. Keep this cast local to that boundary.
  const options = { tool_choice: { type: 'auto', disable_parallel_tool_use: true } } as unknown as Parameters<typeof model.bindTools>[1];
  const result = await model.bindTools([tool], options).invoke([
    new SystemMessage('Be helpful'),
    new HumanMessage({ content: [{ type: 'text', text: 'Read this' }, { type: 'image_url', image_url: 'data:image/png;base64,aGVsbG8=' }] }),
    new AIMessage({ content: [{ type: 'tool_use', id: 'tool_1', name: 'lookup', input: { query: 'test' } }], tool_calls: [{ id: 'tool_1', name: 'lookup', args: { query: 'test' } }] }),
    new ToolMessage({ content: 'value', tool_call_id: 'tool_1' }),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(result.usage_metadata, { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_token_details: { cache_creation: 0, cache_read: 0 } });
  assert.ok(JSON.stringify(result.content).includes('Found'));
});

test('native structured output defaults to a forced function tool and supports strict', async () => {
  const model = modelWithFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal('thinking' in body, false);
    assert.equal(body.tool_choice.type, 'tool');
    assert.equal(body.response_format, undefined);
    assert.equal(body.tools[0].strict, true);
    return Response.json(response([{ type: 'tool_use', id: 'tool_2', name: 'result', input: { value: 'ok' } }], 'tool_use'));
  });
  const result = await model.withStructuredOutput(z.object({ value: z.string() }), { name: 'result', strict: true }).invoke('Return a value');
  assert.deepEqual(result, { value: 'ok' });
});

for (const method of ['jsonSchema', 'jsonMode'] as const) {
  test(`native ${method} uses the SDK JSON schema request and text parser`, async (t) => {
    const warnings = t.mock.method(console, 'warn', () => {});
    let requests = 0;
    const model = modelWithFetch(async (_url, init) => {
      requests += 1;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.output_config.format.type, 'json_schema');
      assert.equal(body.output_config.format.schema.type, 'object');
      assert.deepEqual(body.output_config.format.schema.properties, { value: { type: 'string' } });
      assert.deepEqual(body.output_config.format.schema.required, ['value']);
      assert.equal(body.tools, undefined);
      assert.equal(body.tool_choice, undefined);
      assert.equal(body.response_format, undefined);
      return Response.json(response([{ type: 'text', text: '{"value":"ok"}' }]));
    }, method);
    const result = await model.withStructuredOutput(z.object({ value: z.string() }), { name: 'result', method }).invoke('Return a value');
    assert.deepEqual(result, { value: 'ok' });
    assert.equal(requests, 1);
    // @langchain/anthropic 1.5.1 warns and falls back for jsonMode itself.
    assert.equal(warnings.mock.callCount(), method === 'jsonMode' ? 1 : 0);
  });
}

test('the native SDK rejects explicit strict for JSON schema and JSON mode before requesting', () => {
  let requests = 0;
  const model = modelWithFetch(async () => {
    requests += 1;
    return Response.json(response([{ type: 'text', text: '{"value":"ok"}' }]));
  });
  for (const method of ['jsonSchema', 'jsonMode'] as const) {
    for (const strict of [true, false]) {
      assert.throws(
        () => model.withStructuredOutput(z.object({ value: z.string() }), { name: 'result', method, strict }),
        /strict.*only supported.*functionCalling/,
      );
    }
  }
  assert.equal(requests, 0);
});

test('native stream emits text and usage through LangChain', async () => {
  const events = [
    ['message_start', { message: response([]) }],
    ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hello' } }],
    ['content_block_stop', { index: 0 }],
    ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }],
    ['message_stop', {}],
  ];
  const model = modelWithFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, true);
    assert.equal('thinking' in body, false);
    return new Response(events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data as object })}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  });
  const chunks = [];
  for await (const chunk of await model.stream('Hi')) chunks.push(chunk);
  assert.ok(JSON.stringify(chunks).includes('hello'));
  assert.ok(chunks.some(chunk => chunk.usage_metadata?.output_tokens === 4));
});

test('explicit native thinking settings are preserved in the request', async () => {
  for (const thinking of [{ type: 'disabled' }, { type: 'adaptive' }] as const) {
    let requested = false;
    const model = new AnthropicCompatibleChatModel({
      model: config.model,
      apiKey: config.apiKey,
      maxRetries: 0,
      thinking,
      clientOptions: {
        baseURL: config.baseUrl,
        fetch: async (_url, init) => {
          requested = true;
          assert.deepEqual(JSON.parse(String(init?.body)).thinking, thinking);
          return Response.json(response([{ type: 'text', text: 'ok' }]));
        },
      },
    });
    await model.invoke('Hi');
    assert.equal(requested, true);
  }
});

test('native request forwards cancellation and API errors', async () => {
  const controller = new AbortController();
  const model = modelWithFetch(async (_url, init) => {
    controller.abort();
    assert.ok(init?.signal);
    throw new DOMException('Aborted', 'AbortError');
  });
  await assert.rejects(model.invoke('Hi', { signal: controller.signal }), /abort/i);
  const failing = modelWithFetch(async () => Response.json({ type: 'error', error: { type: 'authentication_error', message: 'Mock rejected' } }, { status: 401 }));
  await assert.rejects(failing.invoke('Hi'), /Mock rejected/);
});

test('native stream assembles tool arguments for the next history turn', async () => {
  const events = [
    ['message_start', { message: response([]) }],
    ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'stream_tool', name: 'lookup', input: {} } }],
    ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":' } }],
    ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '"hello"}' } }],
    ['content_block_stop', { index: 0 }],
    ['message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 4 } }],
    ['message_stop', {}],
  ];
  const model = modelWithFetch(async () => new Response(events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data as object })}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }));
  let combined;
  for await (const chunk of await model.bindTools([tool]).stream('Find hello')) combined = combined ? combined.concat(chunk) : chunk;
  assert.deepEqual(combined?.tool_calls?.map(({ id, name, args }) => ({ id, name, args })), [{ id: 'stream_tool', name: 'lookup', args: { query: 'hello' } }]);
});

test('cancelling an active native stream aborts the SDK request', async () => {
  const controller = new AbortController();
  let sdkSignal: AbortSignal | null | undefined;
  const model = modelWithFetch(async (_url, init) => {
    sdkSignal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: response([]) })}\n\n`));
        init?.signal?.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')), { once: true });
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  });
  const stream = await model.stream('Hi', { signal: controller.signal });
  const iterator = stream[Symbol.asyncIterator]();
  await iterator.next();
  controller.abort();
  await assert.rejects(async () => { for await (const _chunk of { [Symbol.asyncIterator]: () => iterator }) { /* Drain remaining chunks. */ } }, /abort/i);
  assert.equal(sdkSignal?.aborted, true);
});

test('native v3 event stream preserves provider-default thinking and the public text separately', async () => {
  const events = [
    ['message_start', { message: response([]) }],
    ['content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }],
    ['content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'private' } }],
    ['content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'mock-signature' } }],
    ['content_block_stop', { index: 0 }],
    ['content_block_start', { index: 1, content_block: { type: 'redacted_thinking', data: 'mock-redacted' } }],
    ['content_block_stop', { index: 1 }],
    ['content_block_start', { index: 2, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { index: 2, delta: { type: 'text_delta', text: 'public' } }],
    ['content_block_stop', { index: 2 }],
    ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }],
    ['message_stop', {}],
  ];
  const model = modelWithFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, true);
    assert.equal('thinking' in body, false);
    return new Response(events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data as object })}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  });
  const blocks = [];
  let finishProvider: unknown;
  let finishReason: unknown;
  for await (const event of model.streamEvents('Hi')) {
    if (event.event === 'content-block-finish') blocks.push(event.content);
    if (event.event === 'message-finish') {
      finishProvider = event.responseMetadata?.model_provider;
      finishReason = event.reason;
    }
  }
  assert.equal(finishProvider, 'anthropic');
  assert.equal(finishReason, 'stop');
  assert.deepEqual(blocks, [
    { type: 'reasoning', reasoning: 'private', signature: 'mock-signature' },
    { type: 'non_standard', value: { type: 'redacted_thinking', data: 'mock-redacted' } },
    { type: 'text', text: 'public' },
  ]);
});

test('tool-bound legacy stream preserves redacted thinking and visible text in separate blocks', async () => {
  const events = [
    ['message_start', { message: response([]) }],
    ['content_block_start', { index: 0, content_block: { type: 'redacted_thinking', data: 'mock-redacted' } }],
    ['content_block_stop', { index: 0 }],
    ['content_block_start', { index: 1, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'public' } }],
    ['content_block_stop', { index: 1 }],
    ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }],
    ['message_stop', {}],
  ];
  const model = modelWithFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal('thinking' in body, false);
    assert.equal(body.tools[0].name, 'lookup');
    return new Response(events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data as object })}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  });
  let result;
  for await (const chunk of await model.bindTools([tool]).stream('Hi')) result = result ? result.concat(chunk) : chunk;
  assert.equal(result?.text, 'public');
  assert.ok(Array.isArray(result?.content));
  assert.ok(result.content.some(block => typeof block === 'object' && block.type === 'redacted_thinking' && block.data === 'mock-redacted'));
});

test('cancelling an active native v3 event stream aborts the SDK request and stops consumption', { timeout: 5_000 }, async () => {
  const controller = new AbortController();
  let sdkSignal: AbortSignal | null | undefined;
  let sourceAborted = false;
  const model = modelWithFetch(async (_url, init) => {
    sdkSignal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: response([]) })}\n\n`));
        init?.signal?.addEventListener('abort', () => {
          sourceAborted = true;
          stream.error(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  });
  const iterator = model.streamEvents('Hi', { signal: controller.signal })[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value?.event, 'message-start');
  controller.abort();
  // The provider may have already buffered its message-start metadata event.
  // Consume that bounded remainder until cancellation ends the stream.
  let terminated = false;
  for (let i = 0; i < 3 && !terminated; i += 1) {
    try {
      terminated = (await iterator.next()).done === true;
    } catch (error) {
      assert.match(String(error), /abort/i);
      terminated = true;
    }
  }
  assert.equal(terminated, true);
  assert.equal(sdkSignal?.aborted, true);
  assert.equal(sourceAborted, true);
});
