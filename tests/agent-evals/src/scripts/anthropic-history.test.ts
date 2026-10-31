import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatAnthropic } from '@langchain/anthropic';
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
  for (const patched of [false, true]) {
    test(`native ${mode} v3 ${patched ? 'bridge preserves' : 'official adapter drops'} thinking on the next request`, async () => {
      // These official-adapter negative controls deliberately fail once upstream
      // retains provider metadata: remove the bridge and update them at that point.
      const model = patched
        ? buildHostModels({
          protocol: 'anthropic-compatible', model: 'claude-sonnet-4-6', apiKey: 'mock-key',
          baseUrl: 'https://native.example.test', maxRetries: 0,
        }).act
        : new ChatAnthropic({
          model: 'claude-sonnet-4-6', apiKey: 'mock-key', maxRetries: 0,
          clientOptions: { baseURL: 'https://native.example.test' },
        });
      assert.ok(model.bindTools);
      const bound = model.bindTools([lookup]);
      const events = [
        ['message_start', { message: { id: 'msg_first', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
        ['content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
        ['content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'reason' } }],
        ['content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'ing' } }],
        ['content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'mock-signature' } }],
        ['content_block_stop', { index: 0 }],
        ['content_block_start', { index: 1, content_block: { type: 'redacted_thinking', data: 'mock-redacted' } }],
        ['content_block_stop', { index: 1 }],
        ['content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_reused', name: 'lookup', input: {} } }],
        ['content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"query":' } }],
        ['content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '"test"}' } }],
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
          const sse = new TextEncoder().encode(events.map(([type, data]) =>
            `event: ${type}\ndata: ${JSON.stringify({ type, ...data as object })}\n\n`).join(''));
          let offset = 0;
          return new Response(new ReadableStream<Uint8Array>({
            pull(stream) {
              // Exercise the SDK's real SSE decoder across arbitrary byte boundaries.
              if (offset === sse.length) return stream.close();
              const end = Math.min(offset + 37, sse.length);
              stream.enqueue(sse.slice(offset, end));
              offset = end;
            },
          }), { headers: { 'content-type': 'text/event-stream' } });
        }
        assert.equal(requests, 2);
        const expectedThinking = [
          { type: 'thinking', thinking: 'reasoning', signature: 'mock-signature' },
          { type: 'redacted_thinking', data: 'mock-redacted' },
        ];
        assert.deepEqual(body.messages[1].content, [
          ...(patched ? expectedThinking : []),
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
      assert.equal(response.response_metadata.model_provider, patched ? 'anthropic' : undefined);
      // Both SDK paths decode the blocks correctly. The official path loses only
      // the provider marker needed to serialize those same blocks back to Anthropic.
      assert.deepEqual(response.content, [
        { type: 'reasoning', reasoning: 'reasoning', signature: 'mock-signature' },
        { type: 'non_standard', value: { type: 'redacted_thinking', data: 'mock-redacted' } },
        { type: 'tool_call', id: 'toolu_reused', name: 'lookup', args: { query: 'test' } },
      ]);
      const repaired = assignToolCallIds(response, [response]);
      repairedId = repaired.tool_calls?.[0]?.id ?? '';
      assert.ok(repairedId);
      assert.notEqual(repairedId, 'toolu_reused');
      const reply = await bound.invoke([human, repaired, new ToolMessage({ tool_call_id: repairedId, content: 'found' })]);
      assert.equal(reply.text, 'done');
      assert.equal(requests, 2);
    });
  }
}
