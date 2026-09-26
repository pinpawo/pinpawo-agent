import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentMessageEntry } from '@pinpawo/agent-session';
import {
  buildMessageDisplayLines,
  formatMessageTimestamp,
} from './messageDisplay';

test('message display uses timestamps without role labels', () => {
  const createdAt = '2026-07-15T02:00:00.000Z';
  assert.deepEqual(
    buildMessageDisplayLines(message({
      role: 'user',
      text: '第一行\n第二行',
      createdAt,
    })),
    [{
      text: `[${formatMessageTimestamp(createdAt)}]`,
      tone: 'user-label',
    }, {
      text: '  第一行',
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
    })), [{
      text: '| **完成**',
      tone: 'assistant',
    }],
  );
});

test('subagent prose stays out of the timeline; replies show only result reference labels', () => {
  assert.deepEqual(buildMessageDisplayLines(message({ role: 'subagent', text: 'private result' })), []);
  const lines = buildMessageDisplayLines(message({ text: 'done', resultReferences: [
    { id: 'delivery-1', title: 'Inspect files', text: 'private result' },
  ] }));
  assert.match(lines.map(line => line.text).join('\n'), /执行结果 1/);
  assert.doesNotMatch(lines.map(line => line.text).join('\n'), /private result/);
});

test('message display keeps its timestamp label on one terminal row', () => {
  const createdAt = '2026-07-15T02:00:00.000Z';
  assert.deepEqual(
    buildMessageDisplayLines(message({
      role: 'assistant',
      text: 'done',
      createdAt,
    })),
    [{
      text: `[${formatMessageTimestamp(createdAt)}]`,
      tone: 'assistant-label',
    }, {
      text: '| done',
      tone: 'assistant',
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
