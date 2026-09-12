import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { stampAgentMessageCreatedAt } from '@pinpawo/pet-agent';
import { setAgentMessageMetadata } from '../../../../packages/pet-agent/src/agent/messages';
import {
  readTuiCheckpointInputModalities,
  readTuiCheckpointMessages,
  readTuiCheckpointTokenUsage,
  summarizeTuiCheckpointMessages,
} from './transcriptProjection';
import { createLocalChatHumanMessage } from '../agent/chatMessageInput';

test('readTuiCheckpointMessages keeps visible conversation and handoffs', () => {
  const userMessage = stampAgentMessageCreatedAt(
    new HumanMessage(' hello '),
    '2026-06-01T01:00:00.000Z',
  );
  const assistantMessage = stampAgentMessageCreatedAt(
    new AIMessage('assistant reply'),
    '2026-06-01T01:00:01.000Z',
  );
  const messages = readTuiCheckpointMessages([
    new SystemMessage('system'),
    userMessage,
    new AIMessage({
      content: 'subagent hidden',
      additional_kwargs: { pinpawo: { lane: 'subagent' } },
    }),
    new AIMessage({
      content: 'handoff result visible',
      additional_kwargs: {
        pinpawo: {
          delegationAnnounce: {
            version: 1,
            sourceLane: 'capability:general',
            delegationId: 'delegation-1',
            runId: 'run-1',
            announceMessageId: 'announce-1',
            task: '关闭 Issue #272',
            result: 'handoff result visible',
            createdAt: '2026-06-01T01:00:00.000Z',
          },
        },
      },
    }),
    assistantMessage,
  ]);

  assert.deepEqual(messages, [
    { role: 'user', text: 'hello', createdAt: '2026-06-01T01:00:00.000Z' },
    { role: 'subagent', requestId: 'run-1', text: 'handoff result visible' },
    { role: 'assistant', text: 'assistant reply', createdAt: '2026-06-01T01:00:01.000Z' },
  ]);
});

test('readTuiCheckpointMessages restores paired Capability deliveries without exposing private or unmatched results', () => {
  const execution = { taskId: 'task-1', delegationId: 'delegation-1', capability: 'general',
    task: 'Inspect files', mode: 'initial', guidance: null };
  const metadata = { runId: 'run-1', traceId: 'trace-1' };
  const call = setAgentMessageMetadata(new AIMessage({ content: '', tool_calls: [{
    id: 'dispatch-1', name: 'delegate_capability', args: {
      control: { name: 'submit_plan', args: { tasks: [{ capability: 'general', task: execution.task }] } },
      execution,
    },
  }] }), metadata);
  const result = setAgentMessageMetadata(new ToolMessage({ name: 'delegate_capability', tool_call_id: 'dispatch-1',
    content: JSON.stringify({ status: 'returned', delivery: { id: 'delivery-1', task: execution.task,
      text: 'Verified delivery', scope: { ...metadata, delegationId: execution.delegationId, lane: 'capability:general' } } }),
  }), metadata);
  const expected = [{ role: 'subagent', requestId: 'run-1', text: 'Verified delivery' }];
  assert.deepEqual(readTuiCheckpointMessages([call, result]), expected);
  assert.deepEqual(readTuiCheckpointMessages([result]), []);
  for (const overrides of [{ lane: 'capability:general' as const }, { runId: 'other-run' }]) {
    const hidden = setAgentMessageMetadata(new ToolMessage({ ...result, tool_call_id: 'dispatch-1' }), overrides);
    assert.deepEqual(readTuiCheckpointMessages([call, hidden]), []);
  }
  assert.deepEqual(readTuiCheckpointMessages([call, result]), expected);
});

test('readTuiCheckpointMessages hides internal Capability transcript messages', () => {
  const messages = readTuiCheckpointMessages([
    new HumanMessage('real user turn'),
    new HumanMessage({
      content: 'subagent lane echo',
      additional_kwargs: { pinpawo: { lane: 'capability:general' } },
    }),
  ]);

  assert.deepEqual(messages, [{ role: 'user', text: 'real user turn' }]);
});

test('readTuiCheckpointMessages uses attachment display metadata instead of local paths', () => {
  const messages = readTuiCheckpointMessages([
    createLocalChatHumanMessage('review this', [{
      id: 'attachment-1',
      source: 'local-path',
      kind: 'file',
      path: '/Users/example/private/spec.md',
      name: 'spec.md',
    }]),
  ]);

  assert.equal(messages.length, 1);
  assert.equal(
    messages[0]?.text,
    'review this\n\nAttachments:\n- file: spec.md',
  );
  assert.doesNotMatch(messages[0]?.text ?? '', /Users\/example/);
});

test('checkpoint modalities normalize standard and legacy image blocks', () => {
  const standard = new HumanMessage({
    content: [{
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from('standard').toString('base64'),
    }],
  });
  const legacy = new HumanMessage({
    content: [{
      type: 'image_url',
      image_url: {
        url: `data:image/png;base64,${Buffer.from('legacy').toString('base64')}`,
      },
    }],
  });

  assert.deepEqual(readTuiCheckpointInputModalities([standard]), ['text', 'image']);
  assert.deepEqual(readTuiCheckpointInputModalities([legacy]), ['text', 'image']);
  assert.deepEqual(
    readTuiCheckpointInputModalities([new HumanMessage('text only')]),
    ['text'],
  );
});

test('readTuiCheckpointTokenUsage aggregates every provider call but tracks main context', () => {
  const usage = readTuiCheckpointTokenUsage([
    new HumanMessage('hello'),
    new AIMessage({
      content: '',
      usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    }),
    new AIMessage({
      content: 'answer',
      usage_metadata: { input_tokens: 15, output_tokens: 3, total_tokens: 18 },
    }),
    new AIMessage({
      content: 'hidden lane',
      additional_kwargs: { pinpawo: { lane: 'subagent' } },
      usage_metadata: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    }),
  ]);

  assert.deepEqual(usage, {
    inputTokens: 125,
    outputTokens: 55,
    totalTokens: 180,
    latestInputTokens: 15,
    source: 'provider',
    scope: 'session',
  });
});

test('summarizeTuiCheckpointMessages derives title from first user message', () => {
  const summary = summarizeTuiCheckpointMessages([
    { role: 'assistant', text: '先回答' },
    { role: 'user', text: '  标题   带   空格  ' },
  ], '2026-06-02T00:00:00.000Z');

  assert.deepEqual(summary, {
    title: '标题 带 空格',
    messageCount: 2,
    updatedAt: '2026-06-02T00:00:00.000Z',
  });
  assert.equal(summarizeTuiCheckpointMessages([], '2026-06-02T00:00:00.000Z').title, '空会话');
});
