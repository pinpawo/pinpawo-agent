import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import {
  messageHasToolCalls,
  readToolCallIds,
  readToolCalls,
  readToolMessageCallId,
} from './toolMessages';

test('tool message helpers read normalized tool calls from AI message shapes', () => {
  const standard = new AIMessage({
    content: '',
    tool_calls: [
      { id: 'call-1', name: 'read_file', args: { path: 'README.md' } },
      { id: '', name: 'ignored', args: {} },
    ],
  });
  const legacy = new AIMessage({
    content: '',
    additional_kwargs: {
      tool_calls: [
        {
          id: 'call-2',
          type: 'function',
          function: { name: 'run_shell', arguments: '{"command":"pwd"}' },
        },
        { id: 'call-3', type: 'function', function: { name: '', arguments: '{}' } },
      ],
    },
  });

  assert.deepEqual(readToolCalls(standard), [
    { id: 'call-1', name: 'read_file', args: { path: 'README.md' } },
  ]);
  assert.deepEqual(readToolCalls(legacy), [
    { id: 'call-2', name: 'run_shell', args: { command: 'pwd' } },
  ]);
  assert.deepEqual(readToolCallIds(legacy), ['call-2', 'call-3']);
  assert.equal(messageHasToolCalls(standard), true);
  assert.equal(messageHasToolCalls(new HumanMessage('hello')), false);
});

test('tool message helpers safely read tool result call ids', () => {
  const result = new ToolMessage({
    content: 'done',
    tool_call_id: 'call-1',
  });

  assert.equal(readToolMessageCallId(result), 'call-1');
  assert.equal(readToolMessageCallId(new HumanMessage('hello')), null);
});
