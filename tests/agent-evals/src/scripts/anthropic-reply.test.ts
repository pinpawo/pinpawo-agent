import assert from 'node:assert/strict';
import test from 'node:test';
import { HumanMessage } from '@langchain/core/messages';
import { buildHostModels } from '../../../../services/host/src/agent/agentModels.ts';
import { HostChatAnthropic } from '../../../../services/host/src/agent/hostChatAnthropic.ts';
import { runAgent } from '../../../../packages/pet-agent/src/agent/runAgent.ts';

test('native Messages thinking and text reach the public runAgent reply', async () => {
  const model = buildHostModels({
    protocol: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'mock-key',
    baseUrl: 'https://native.example.test', maxRetries: 0,
  }).act;
  assert.ok(model instanceof HostChatAnthropic);
  let requested = false;
  model.clientOptions.fetch = async (url, init) => {
    requested = true;
    assert.equal(String(url), 'https://native.example.test/v1/messages');
    assert.equal('thinking' in JSON.parse(String(init?.body)), false);
    return Response.json({ id: 'msg_mock', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'thinking', thinking: 'private reasoning', signature: 'mock-signature' },
        { type: 'text', text: 'Hello from Claude' }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 2 } });
  };
  const graph = { invoke: async () => ({ messages: [await model.invoke('Hi')] }) };
  const result = await runAgent(graph as never, { messages: [new HumanMessage('Hi')] });
  assert.equal(requested, true);
  assert.equal(result.reply, 'Hello from Claude');
});
