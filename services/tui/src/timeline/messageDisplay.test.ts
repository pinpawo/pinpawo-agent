import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentMessageEntry } from '@pinpawo/agent-session';
import {
  buildMessageDisplayLines,
  formatMessageTimestamp,
} from './messageDisplay';

test('message display preserves legacy role labels and multiline structure', () => {
  const createdAt = '2026-07-15T02:00:00.000Z';
  assert.deepEqual(
    buildMessageDisplayLines(message({
      role: 'user',
      text: '第一行\n第二行',
      createdAt,
    }), '小派'),
    [{
      text: `[${formatMessageTimestamp(createdAt)}] 你`,
      tone: 'user-label',
    }, {
      text: '> 第一行',
      tone: 'user',
    }, {
      text: '  第二行',
      tone: 'user',
    }],
  );
  assert.deepEqual(
    buildMessageDisplayLines(message({
      role: 'assistant',
      text: '**完成**',
    }), '小派'),
    [{
      text: '小派',
      tone: 'assistant-label',
    }, {
      text: '| **完成**',
      tone: 'assistant',
    }],
  );
});

test('message display keeps subagent content visually distinct', () => {
  assert.deepEqual(
    buildMessageDisplayLines(message({
      role: 'subagent',
      text: '先检查文件。\n\n再汇总。',
    })),
    [{
      text: 'subagent',
      tone: 'subagent',
    }, {
      text: '  先检查文件。',
      tone: 'subagent',
    }, {
      text: '   ',
      tone: 'subagent',
    }, {
      text: '  再汇总。',
      tone: 'subagent',
    }],
  );
});

function message(
  overrides: Partial<AgentMessageEntry>,
): AgentMessageEntry {
  return {
    id: 'message',
    type: 'message',
    role: 'assistant',
    text: 'hello',
    status: 'completed',
    ...overrides,
  };
}
