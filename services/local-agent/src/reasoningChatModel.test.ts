import assert from 'node:assert/strict';
import test from 'node:test';
import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { ReasoningChatModel } from './reasoningChatModel';

for (const streaming of [false, true]) {
  test(`reasoning survives a tool-error retry (streaming=${streaming})`, async () => {
    const requests: Record<string, any>[] = [];
    const model = new ReasoningChatModel({ model: 'deepseek-flash', apiKey: 'test', streaming, maxRetries: 0,
      configuration: { fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        requests.push(request);
        const message = requests.length === 1
          ? { role: 'assistant', content: '', reasoning_content: 'synthetic reasoning',
              tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'plan_request', arguments: '{"goal":"too long"}' } }] }
          : { role: 'assistant', content: 'Corrected.', reasoning_content: 'synthetic correction' };
        if (request.stream) {
          const delta = { ...message, tool_calls: message.tool_calls?.map((call, index) => ({ ...call, index })) };
          const chunk = { id: 'response', object: 'chat.completion.chunk', model: 'deepseek-flash',
            choices: [{ index: 0, delta, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] };
          return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
        }
        return new Response(JSON.stringify({ id: 'response', object: 'chat.completion', model: 'deepseek-flash',
          choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }),
        { headers: { 'content-type': 'application/json' } });
      } },
    });
    // Avoid tokenizer downloads; this test exercises the provider wire protocol.
    model.getNumTokens = async () => 0;
    const human = new HumanMessage('Prepare a plan.');
    const first = (await model._generate([human], {})).generations[0].message;
    assert.equal(first.additional_kwargs.reasoning_content, 'synthetic reasoning');
    const result = (await model._generate([human, first, new ToolMessage({ tool_call_id: 'call-1', content: 'Goal too long; retry.', status: 'error' })], {})).generations[0].message;
    assert.equal(result.text, 'Corrected.');
    const assistant = requests[1].messages.find((m: { role: string }) => m.role === 'assistant');
    assert.equal(assistant.reasoning_content, 'synthetic reasoning');
    assert.equal(assistant.tool_calls[0].id, 'call-1');
    assert.equal(requests[0].messages[0].reasoning_content, undefined);
  });
}
