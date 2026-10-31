import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import {
  messageHasToolCalls,
  readContentText,
  readMessageText,
  readMessageToolCallIds,
  readMessageToolCalls,
  readToolResultCallId,
} from './messages';
import { toolProtocolSafeMessages } from '../agent/messages';

test('message text reads normalized AI text without reasoning or tool data', () => {
  const message = new AIMessage({ content: [
    { type: 'text', text: ' Hello' },
    { type: 'thinking', thinking: 'private reasoning', signature: 'sig' },
    { type: 'tool_use', id: 'call-1', name: 'lookup', input: { text: 'private arguments' } },
    { type: 'image_url', image_url: 'data:image/png;base64,aW1hZ2U=' },
    { type: 'text', text: ' world ' },
  ], additional_kwargs: { pinpawo: { localChatDisplayText: 'UI override' } } });

  assert.equal(readMessageText(message), 'Hello world');
});

test('message text reads standard Human and Tool text blocks around images', () => {
  const messages = [
    new HumanMessage({ content: [
      { type: 'text', text: ' first ' },
      { type: 'image_url', image_url: 'data:image/png;base64,aW1hZ2U=' },
      { type: 'text', text: 'second ' },
    ] }),
    new ToolMessage({ content: [
      { type: 'text', text: ' first ' },
      { type: 'image_url', image_url: 'data:image/png;base64,aW1hZ2U=' },
      { type: 'text', text: 'second ' },
    ], tool_call_id: 'call-1' }),
  ];
  for (const message of messages) {
    assert.equal(readMessageText(message), 'first second');
  }
  assert.equal(readMessageText(new HumanMessage(' hello ')), 'hello');
});

test('raw content reader preserves strings and ignores missing content', () => {
  assert.equal(readContentText(' hello '), ' hello ');
  assert.equal(readContentText(null), null);
});

test('message utils read normalized tool calls from AI message shapes', () => {
  const standard = new AIMessage({
    content: '',
    tool_calls: [
      { id: 'call-1', name: 'read_file', args: { path: 'README.md' } },
      { id: '', name: 'missing_id', args: {} },
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

  assert.deepEqual(readMessageToolCalls(standard), [
    { id: 'call-1', name: 'read_file', args: { path: 'README.md' } },
  ]);
  assert.deepEqual(readMessageToolCalls(standard, {
    fallbackIdPrefix: 'supervisor:1',
  }), [
    { id: 'call-1', name: 'read_file', args: { path: 'README.md' } },
    { id: 'supervisor:1:1', name: 'missing_id', args: {} },
  ]);
  assert.deepEqual(readMessageToolCalls(legacy), [
    { id: 'call-2', name: 'run_shell', args: { command: 'pwd' } },
  ]);
  assert.deepEqual(readMessageToolCallIds(legacy), ['call-2', 'call-3']);
  assert.equal(messageHasToolCalls(standard), true);
  assert.equal(messageHasToolCalls(new HumanMessage('hello')), false);
});

test('message utils safely read tool result call ids', () => {
  const result = new ToolMessage({
    content: 'done',
    tool_call_id: 'call-1',
  });

  assert.equal(readToolResultCallId(result), 'call-1');
  assert.equal(readToolResultCallId(new HumanMessage('hello')), null);
});

test('a response whose only call is malformed still counts its raw provider call (#680)', () => {
  // The shape LangChain builds when a provider returns tool call arguments that are not JSON.
  const malformed = new AIMessage({
    content: '',
    tool_calls: [],
    invalid_tool_calls: [{ id: 'bad-1', name: 'capability_search', args: '{"query":', error: 'Invalid JSON', type: 'invalid_tool_call' }],
    additional_kwargs: {
      tool_calls: [{ id: 'bad-1', type: 'function', function: { name: 'capability_search', arguments: '{"query":' } }],
    },
  });
  assert.deepEqual(readMessageToolCallIds(malformed), ['bad-1']);
  assert.equal(messageHasToolCalls(malformed), true);

  // Model input drops the orphaned call instead of sending it without a result.
  const user = new HumanMessage('Find a capability.');
  const next = new HumanMessage('Try again.');
  assert.deepEqual(toolProtocolSafeMessages([user, malformed, next]), [user, next]);

  const answered = new ToolMessage({ tool_call_id: 'bad-1', content: 'Invalid JSON', status: 'error' });
  assert.deepEqual(toolProtocolSafeMessages([user, malformed, answered]), [user, malformed, answered]);
  assert.deepEqual(readMessageToolCallIds(new AIMessage({ content: 'done', tool_calls: [] })), []);
});
