import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { ChatModelStream } from '@langchain/core/language_models/stream';
import type { ChatModelStreamEvent } from '@langchain/core/language_models/event';
import { z } from 'zod';
import { StateGraph, MessagesAnnotation, START, END } from '@langchain/langgraph';
import { buildHostModels } from '../../../../services/host/src/agent/agentModels.ts';
import { assignToolCallIds } from '../../../../packages/pet-agent/src/agent/orchestrator/modelInvocation.ts';

const lookup = tool(async () => 'found', {
  name: 'lookup', description: 'Look up a query', schema: z.object({ query: z.string() }),
});

for (const outputVersion of ['v0', 'v1'] as const) {
  test(`native ${outputVersion} history preserves signed thinking and tool pairing after ID repair`, async () => {
    const model = buildHostModels({
      protocol: 'anthropic-compatible', model: 'claude-sonnet-4-6', apiKey: 'mock-key',
      baseUrl: 'https://native.example.test', maxRetries: 0,
    }).act;
    assert.ok(model.bindTools);
    const bound = model.bindTools([lookup]);
    let requests = 0;
    let repairedId = '';
    (model as unknown as { clientOptions: { fetch: typeof fetch } }).clientOptions.fetch = async (_url, init) => {
      requests++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.tools[0].name, 'lookup');
      if (requests === 1) {
        return Response.json({ id: 'msg_first', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
          content: [
            { type: 'thinking', thinking: 'reasoning', signature: 'mock-signature' },
            { type: 'redacted_thinking', data: 'mock-redacted' },
            { type: 'tool_use', id: 'toolu_reused', name: 'lookup', input: { query: 'test' } },
          ], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
      }
      assert.equal(requests, 2);
      const assistant = body.messages[1];
      const results = body.messages[2];
      assert.equal(assistant.role, 'assistant');
      assert.deepEqual(assistant.content, [
        { type: 'thinking', thinking: 'reasoning', signature: 'mock-signature' },
        { type: 'redacted_thinking', data: 'mock-redacted' },
        { type: 'tool_use', id: repairedId, name: 'lookup', input: { query: 'test' } },
      ]);
      assert.equal(results.role, 'user');
      assert.deepEqual(results.content, [{ type: 'tool_result', tool_use_id: repairedId, content: 'found' }]);
      return Response.json({ id: 'msg_second', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } });
    };
    const human = new HumanMessage('Find test');
    const response = await bound.invoke([human], { outputVersion });
    assert.equal(response.tool_calls?.[0]?.id, 'toolu_reused');
    const repaired = assignToolCallIds(response, [response]);
    repairedId = repaired.tool_calls?.[0]?.id ?? '';
    assert.ok(repairedId);
    assert.notEqual(repairedId, 'toolu_reused');
    const reply = await bound.invoke([human, repaired, new ToolMessage({ tool_call_id: repairedId, content: 'found' })]);
    assert.equal(reply.text, 'done');
    assert.equal(requests, 2);
  });
}

for (const mode of ['model', 'graph'] as const) {
test(`native ${mode} v3 streaming preserves redacted thinking and tool pairing in the next request`, async () => {
  const model = buildHostModels({
    protocol: 'anthropic-compatible', model: 'claude-sonnet-4-6', apiKey: 'mock-key',
    baseUrl: 'https://native.example.test', maxRetries: 0,
  }).act;
  assert.ok(model.bindTools);
  const bound = model.bindTools([lookup]);
  const events = [
    ['message_start', { message: { id: 'msg_first', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ['content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
    ['content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'reasoning' } }],
    ['content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'mock-signature' } }],
    ['content_block_stop', { index: 0 }],
    ['content_block_start', { index: 1, content_block: { type: 'redacted_thinking', data: 'mock-redacted' } }],
    ['content_block_stop', { index: 1 }],
    ['content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_reused', name: 'lookup', input: {} } }],
    ['content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"query":"test"}' } }],
    ['content_block_stop', { index: 2 }],
    ['message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', {}],
  ];
  let requests = 0;
  let repairedId = '';
  (model as unknown as { clientOptions: { fetch: typeof fetch } }).clientOptions.fetch = async (_url, init) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.tools[0].name, 'lookup');
    if (requests === 1) {
      assert.equal(body.stream, true);
      return new Response(events.map(([type, data]) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...data as object })}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } });
    }
    assert.deepEqual(body.messages[1].content, [
      { type: 'thinking', thinking: 'reasoning', signature: 'mock-signature' },
      { type: 'redacted_thinking', data: 'mock-redacted' },
      { type: 'tool_use', id: repairedId, name: 'lookup', input: { query: 'test' } },
    ]);
    assert.deepEqual(body.messages[2].content, [{ type: 'tool_result', tool_use_id: repairedId, content: 'found' }]);
    return Response.json({ id: 'msg_second', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } });
  };
  const human = new HumanMessage('Find test');
  let response;
  if (mode === 'model') {
    const eventsStream = bound.streamEvents([human], { version: 'v3' } as never) as unknown as AsyncIterable<ChatModelStreamEvent>;
    response = await new ChatModelStream(eventsStream);
  } else {
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('model', async (state, runnableConfig) => ({ messages: [await bound.invoke(state.messages, runnableConfig)] }))
      .addEdge(START, 'model').addEdge('model', END).compile();
    const run = await graph.streamEvents({ messages: [human] }, { version: 'v3' });
    const values = await run.values;
    response = values.messages.at(-1)!;
  }
  assert.ok(AIMessage.isInstance(response));
  assert.equal(response.response_metadata.output_version, 'v1');
  assert.equal(response.response_metadata.model_provider, 'anthropic');
  const repaired = assignToolCallIds(response, [response]);
  repairedId = repaired.tool_calls?.[0]?.id ?? '';
  assert.ok(repairedId);
  assert.notEqual(repairedId, 'toolu_reused');
  const reply = await bound.invoke([human, repaired, new ToolMessage({ tool_call_id: repairedId, content: 'found' })]);
  assert.equal(reply.text, 'done');
});
}
