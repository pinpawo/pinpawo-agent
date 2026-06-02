import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTuiActionsFromServerMessage } from './tui/tuiServerMessageActions';

function historyCells() {
  let index = 0;
  return () => {
    index += 1;
    return {
      id: `cell-${index}`,
      timestamp: `10:00:0${index}`,
    };
  };
}

test('buildTuiActionsFromServerMessage ignores pong messages', () => {
  assert.deepEqual(
    buildTuiActionsFromServerMessage({ type: 'pong' }, {
      now: 1000,
      makeHistoryCell: historyCells(),
    }),
    { actions: [], clearInterrupt: false },
  );
});

test('buildTuiActionsFromServerMessage maps local-agent events to event.received actions', () => {
  const message = {
    type: 'event' as const,
    requestId: 'req-1',
    event: {
      type: 'message.completed' as const,
      requestId: 'req-1',
      role: 'assistant' as const,
      text: 'done',
    },
  };

  assert.deepEqual(
    buildTuiActionsFromServerMessage(message, {
      now: 1000,
      makeHistoryCell: historyCells(),
    }),
    {
      clearInterrupt: true,
      actions: [{
        type: 'event.received',
        event: message.event,
        now: 1000,
        historyCell: {
          id: 'cell-1',
          timestamp: '10:00:01',
        },
      }],
    },
  );
});

test('buildTuiActionsFromServerMessage keeps streaming event interrupts intact', () => {
  const result = buildTuiActionsFromServerMessage({
    type: 'event',
    requestId: 'req-1',
    event: {
      type: 'message.delta',
      requestId: 'req-1',
      role: 'assistant',
      text: 'partial',
    },
  }, {
    now: 1000,
    makeHistoryCell: historyCells(),
  });

  assert.equal(result.clearInterrupt, false);
  assert.equal(result.actions[0]?.type, 'event.received');
});

test('buildTuiActionsFromServerMessage maps control messages to TUI actions', () => {
  assert.deepEqual(
    buildTuiActionsFromServerMessage({
      type: 'interrupting',
      requestId: 'req-1',
      message: 'interrupting',
    }, {
      now: 1000,
      makeHistoryCell: historyCells(),
    }),
    {
      clearInterrupt: false,
      actions: [{
        type: 'server.interrupting',
        requestId: 'req-1',
        statusMessage: '正在打断',
      }],
    },
  );

  assert.deepEqual(
    buildTuiActionsFromServerMessage({
      type: 'interrupted',
      requestId: 'req-1',
      message: 'interrupted',
    }, {
      now: 1000,
      makeHistoryCell: historyCells(),
    }),
    {
      clearInterrupt: true,
      actions: [{
        type: 'server.interrupted',
        requestId: 'req-1',
        historyCell: {
          id: 'cell-1',
          timestamp: '10:00:01',
        },
        statusMessage: '已打断',
      }],
    },
  );
});

test('buildTuiActionsFromServerMessage maps studio control messages', () => {
  assert.deepEqual(
    buildTuiActionsFromServerMessage({
      type: 'studio_response',
      requestId: 'studio-1',
      outcome: 'stopped',
      reply: '',
      reason: 'done enough',
    }, {
      now: 1000,
      makeHistoryCell: historyCells(),
    }),
    {
      clearInterrupt: true,
      actions: [{
        type: 'server.studio_response',
        requestId: 'studio-1',
        outcome: 'stopped',
        reply: '',
        reason: 'done enough',
        historyCell: {
          id: 'cell-1',
          timestamp: '10:00:01',
        },
        stoppedReasonCell: {
          id: 'cell-2',
          timestamp: '10:00:02',
        },
        statusMessage: '就绪',
      }],
    },
  );

  assert.deepEqual(
    buildTuiActionsFromServerMessage({
      type: 'studio_error',
      requestId: 'studio-2',
      message: 'planner failed',
    }, {
      now: 1000,
      makeHistoryCell: historyCells(),
    }),
    {
      clearInterrupt: true,
      actions: [{
        type: 'server.studio_error',
        requestId: 'studio-2',
        message: 'planner failed',
        historyCell: {
          id: 'cell-1',
          timestamp: '10:00:01',
        },
        statusMessage: 'Studio 出错，已恢复输入',
      }],
    },
  );
});
