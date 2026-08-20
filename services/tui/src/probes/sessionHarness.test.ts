import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySpikeEvent,
  beginSpikeRun,
  createSpikeSession,
  formatSpikeTimelineEntry,
} from './sessionHarness';

test('spike session uses the shared projection and preserves timeline order', () => {
  const session = createSpikeSession(2);

  assert.deepEqual(
    session.timeline.map((entry) => entry.type === 'operation'
      ? `${entry.type}:${entry.phase}`
      : `${entry.type}:${entry.role}`),
    [
      'message:user',
      'operation:completed',
      'message:assistant',
      'message:user',
      'operation:completed',
      'message:assistant',
    ],
  );
  assert.equal(session.activeRun, null);
  assert.deepEqual(
    session.timeline
      .filter((entry) => entry.type === 'operation')
      .map((entry) => entry.raw),
    [
      {
        input: { index: 0 },
        output: { index: 0 },
      },
      {
        input: { index: 1 },
        output: { index: 1 },
      },
    ],
  );
});

test('spike session applies high-frequency deltas in place', () => {
  let session = beginSpikeRun(createSpikeSession(0), 'delta-1', 1_000);
  for (const token of ['Open', 'TUI', ' ', '宽字符', '🙂']) {
    session = applySpikeEvent(session, {
      type: 'message.delta',
      requestId: 'delta-1',
      // 同一条消息的所有 delta 共享 messageId —— 用例断言它们合并成一行。
      messageId: 'message-delta-1',
      role: 'assistant',
      text: token,
    }, 1_001);
  }

  assert.equal(session.timeline.length, 2);
  assert.deepEqual(session.timeline[1], {
    id: 'delta-1:assistant:message-delta-1',
    type: 'message',
    role: 'assistant',
    requestId: 'delta-1',
    text: 'OpenTUI 宽字符🙂',
    status: 'streaming',
    createdAt: '1970-01-01T00:00:01.001Z',
    updatedAt: '1970-01-01T00:00:01.001Z',
  });
});

test('spike timeline formatter keeps message and operation semantics distinct', () => {
  const session = createSpikeSession(1);

  assert.deepEqual(session.timeline.map(formatSpikeTimelineEntry), [
    'user       Probe turn 1: verify ordered timeline rendering.',
    '  ● Render timeline row row-1 — completed',
    'assistant  Rendered turn 1. 宽字符 🙂 stay aligned.',
  ]);
});
