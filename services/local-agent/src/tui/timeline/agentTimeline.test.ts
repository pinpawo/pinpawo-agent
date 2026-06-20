import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isAgentTimelineMessage,
  timelineMessagesFromEntries,
  timelineMessagesFromHistory,
  type AgentTimelineEntry,
} from './agentTimeline';

test('CORE-2 timeline messages include only checkpoint-backed message and operation entries', () => {
  const entries: AgentTimelineEntry[] = [
    {
      id: 'user-1',
      type: 'message',
      role: 'user',
      text: 'hello',
      status: 'completed',
    },
    {
      id: 'assistant-1',
      type: 'message',
      role: 'assistant',
      text: 'hi',
      status: 'streaming',
    },
    {
      id: 'tool-1',
      type: 'operation',
      requestId: 'req-1',
      phase: 'started',
      operationKey: 'shell:pwd',
      kind: 'shell',
      title: 'pwd',
      summary: 'pwd',
      startedAt: 1,
      updatedAt: 1,
    },
    {
      id: 'subagent-1',
      type: 'message',
      role: 'subagent',
      text: 'internal progress',
      status: 'streaming',
    },
    {
      id: 'review-1',
      type: 'review',
      requestId: 'req-1',
      reviewId: 'approval-1',
      status: 'waiting',
    },
    {
      id: 'notice-1',
      type: 'notice',
      text: 'connected',
    },
    {
      id: 'studio-1',
      type: 'studio.progress',
      requestId: 'req-1',
      text: 'writing file',
    },
  ];

  assert.deepEqual(timelineMessagesFromEntries(entries).map((entry) => entry.id), [
    'user-1',
    'assistant-1',
    'tool-1',
  ]);
  assert.equal(isAgentTimelineMessage(entries[3]!), false);
  assert.equal(isAgentTimelineMessage(entries[4]!), false);
  assert.equal(isAgentTimelineMessage(entries[5]!), false);
  assert.equal(isAgentTimelineMessage(entries[6]!), false);
});

test('CORE-2 history import maps only user and assistant cells into timeline messages', () => {
  const messages = timelineMessagesFromHistory([
    {
      id: 'user-cell',
      kind: 'user',
      text: 'hello',
      timestamp: '10:00:00',
    },
    {
      id: 'system-cell',
      kind: 'system',
      text: 'connected',
      timestamp: '10:00:01',
    },
    {
      id: 'assistant-cell',
      kind: 'assistant',
      text: 'hi',
      timestamp: '10:00:02',
    },
  ]);

  assert.deepEqual(messages.map((entry) => [entry.id, entry.type, entry.role, entry.text]), [
    ['history:user-cell', 'message', 'user', 'hello'],
    ['history:assistant-cell', 'message', 'assistant', 'hi'],
  ]);
});
