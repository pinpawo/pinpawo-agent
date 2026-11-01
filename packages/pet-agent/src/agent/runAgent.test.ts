import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { runAgent } from './runAgent';

async function runWithMessages(messages: BaseMessage[]) {
  const graph = { invoke: async () => ({ messages }) };
  return runAgent(graph as never, { messages: [new HumanMessage('Hi')] });
}

test('runAgent returns only normalized text from a multi-block model reply', async () => {
  const message = new AIMessage({ content: [
    { type: 'thinking', thinking: 'private reasoning', signature: 'mock-signature' },
    { type: 'text', text: ' Hello ' },
    { type: 'tool_use', id: 'tool_1', name: 'lookup', input: { text: 'private arguments' } },
    { type: 'text', text: 'world ' },
  ] });
  const result = await runWithMessages([message]);
  assert.equal(result.reply, 'Hello world');
  assert.equal(result.messages[0], message);
});

test('runAgent keeps ordinary string replies and empty outputs compatible', async () => {
  assert.equal((await runWithMessages([new AIMessage('  hello  ')])).reply, 'hello');
  assert.equal((await runWithMessages([])).reply, '');
  assert.equal((await runWithMessages([new AIMessage({ content: [
    { type: 'thinking', thinking: 'private reasoning', signature: 'mock-signature' },
    { type: 'tool_use', id: 'tool_1', name: 'lookup', input: { text: 'private arguments' } },
  ] })])).reply, '');
  assert.equal((await runWithMessages([new ToolMessage({ content: ' result ', tool_call_id: 'tool_1' })])).reply, 'result');
  assert.equal((await runWithMessages([new HumanMessage(' user text ')])).reply, 'user text');
  assert.equal((await runWithMessages([new HumanMessage({ content: [{ type: 'text', text: 'user text' }] })])).reply, '');
  assert.equal((await runWithMessages([new ToolMessage({ content: [{ type: 'text', text: 'tool output' }], tool_call_id: 'tool_1' })])).reply, '');
  assert.equal((await runWithMessages([new AIMessage({
    content: [{ type: 'text', text: 'Preparing a tool call' },
      { type: 'tool_use', id: 'tool_1', name: 'lookup', input: {} }],
    tool_calls: [{ id: 'tool_1', name: 'lookup', args: {} }],
  })])).reply, '');
});
