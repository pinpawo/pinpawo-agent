import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { DelegationAnnounceMessage } from './delegation';
import { buildAgentModelMessages } from './modelMessages';

test('buildAgentModelMessages projects canonical history and appends current input', () => {
  const request = new HumanMessage('检查代码并继续。');
  const accepted = new DelegationAnnounceMessage({
    id: 'accepted-1',
    sourceLane: 'capability:explore',
    delegationId: 'delegation-accepted',
    runId: 'run-old',
    announceMessageId: 'announce-old',
    task: '检查历史实现',
    completionReason: 'natural',
    result: '历史实现已检查。',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const current = new HumanMessage('CURRENT_INVOCATION_INPUT');

  const messages = buildAgentModelMessages({
    history: [request, accepted],
    current: [current],
  });

  assert.equal(messages.length, 3);
  assert.equal(messages[0], request);
  assert.notEqual(messages[1], accepted);
  assert.match(messages[1]?.text ?? '', /<delegation_announce/);
  assert.match(messages[1]?.text ?? '', /历史实现已检查/);
  assert.equal(messages[2], current);
  assert.equal(accepted.text, '历史实现已检查。');
});

test('buildAgentModelMessages repairs tool protocol after appending current input', () => {
  const toolCall = new AIMessage({
    content: '',
    tool_calls: [{ id: 'call-1', name: 'inspect', args: {} }],
  });
  const toolResult = new ToolMessage({
    content: 'inspection complete',
    tool_call_id: 'call-1',
  });

  const messages = buildAgentModelMessages({
    history: [toolCall],
    current: [toolResult],
  });

  assert.deepEqual(messages, [toolCall, toolResult]);
});
