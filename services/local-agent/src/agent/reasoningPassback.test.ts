import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { buildLocalAgentModels } from './agentModels';
import { buildCompletionsMessagesWithReasoning } from './reasoningPassback';

type RequestBody = { stream?: boolean; messages: Array<Record<string, unknown>> };

async function readBody(req: IncomingMessage): Promise<RequestBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function withFakeProvider(
  run: (baseUrl: string, requests: RequestBody[]) => Promise<void>,
) {
  const requests: RequestBody[] = [];
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push(body);
    const delta = {
      role: 'assistant',
      content: '',
      reasoning_content: 'need the weather',
      tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{}' } }],
    };
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = { id: 'r1', object: 'chat.completion.chunk', created: 0, model: 'deepseek-v4-pro',
        choices: [{ index: 0, delta, finish_reason: 'tool_calls' }] };
      res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    const { tool_calls, ...message } = delta;
    res.end(JSON.stringify({
      id: 'r1', object: 'chat.completion', created: 0, model: 'deepseek-v4-pro',
      choices: [{ index: 0, message: { ...message, tool_calls: tool_calls.map(({ index: _i, ...call }) => call) },
        finish_reason: 'tool_calls' }],
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests);
  } finally {
    server.close();
  }
}

function assistantTurns(body: RequestBody) {
  return body.messages.filter(message => message.role === 'assistant');
}

test('assistant reasoning is sent back from additional_kwargs and reasoning blocks', () => {
  const messages: BaseMessage[] = [
    new HumanMessage('hi'),
    new AIMessage({
      content: '',
      additional_kwargs: { reasoning_content: 'kwargs reasoning' },
      tool_calls: [{ id: 'a', name: 'weather', args: {} }],
    }),
    new ToolMessage({ content: 'sunny', tool_call_id: 'a' }),
    new AIMessage({
      content: [{ type: 'reasoning', reasoning: 'block ' }, { type: 'reasoning', reasoning: 'reasoning' }],
      tool_calls: [{ id: 'b', name: 'weather', args: {} }],
    }),
    new ToolMessage({ content: 'rainy', tool_call_id: 'b' }),
    new AIMessage('no reasoning'),
  ];

  const params = buildCompletionsMessagesWithReasoning(messages, 'deepseek-v4-pro');

  assert.equal(params.length, messages.length);
  assert.deepEqual(
    params.filter(param => param.role === 'assistant').map(param => (param as { reasoning_content?: string }).reasoning_content),
    ['kwargs reasoning', 'block reasoning', undefined],
  );
});

for (const streaming of [false, true]) {
  test(`tool-call turn round-trips reasoning_content to the provider (streaming=${streaming})`, async () => {
    await withFakeProvider(async (baseUrl, requests) => {
      const { act } = buildLocalAgentModels({ apiKey: 'test-key', baseUrl, model: 'deepseek-v4-pro' });
      const history: BaseMessage[] = [new HumanMessage('weather?')];
      const first = streaming
        ? await (async () => {
          let merged;
          for await (const chunk of await act.stream(history)) merged = merged ? merged.concat(chunk) : chunk;
          return new AIMessage({ ...merged! });
        })()
        : await act.invoke(history);
      assert.equal(first.tool_calls?.length, 1);

      history.push(first, new ToolMessage({ content: 'sunny', tool_call_id: 'call_1' }));
      await act.invoke(history);

      assert.equal(requests.length, 2);
      assert.deepEqual(
        assistantTurns(requests[1]!).map(message => message.reasoning_content),
        ['need the weather'],
      );
    });
  });
}
