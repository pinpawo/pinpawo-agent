import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTuiActionsFromServerMessage } from './tui/tuiServerMessageActions';

function messages() {
  let index = 0;
  return (input: {
    role: 'user' | 'assistant' | 'system' | 'subagent';
    text: string;
    requestId?: string;
  }) => {
    index += 1;
    return {
      id: `message:cell-${index}`,
      createdAt: `2026-07-15T02:00:0${index}.000Z`,
      ...input,
    };
  };
}

test('buildTuiActionsFromServerMessage ignores pong messages', () => {
  assert.deepEqual(
    buildTuiActionsFromServerMessage({ type: 'pong' }, {
      now: 1000,
      createMessage: messages(),
    }),
    { actions: [] },
  );
});

test('buildTuiActionsFromServerMessage keeps session command responses out of reducers', () => {
  assert.deepEqual(
    buildTuiActionsFromServerMessage({
      type: 'session.error',
      requestId: 'resume-1',
      operation: 'resume',
      message: 'session not found',
    }, {
      now: 1000,
      createMessage: messages(),
    }),
    { actions: [] },
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
      createMessage: messages(),
    }),
    {
      actions: [{
        type: 'event.received',
        event: message.event,
        now: 1000,
      }],
    },
  );
});

test('buildTuiActionsFromServerMessage normalizes displayable runtime events', () => {
  const cases = [
    {
      event: {
        type: 'system.notice' as const,
        requestId: 'req-1',
        message: '  授权已更新  ',
      },
      text: '授权已更新',
    },
    {
      event: {
        type: 'error' as const,
        requestId: 'req-1',
        message: 'planner failed',
      },
      text: '出错：planner failed',
    },
  ];

  for (const { event, text } of cases) {
    assert.deepEqual(
      buildTuiActionsFromServerMessage({
        type: 'event',
        requestId: 'req-1',
        event,
      }, {
        now: 1000,
        createMessage: messages(),
      }).actions[0],
      {
        type: 'event.received',
        event,
        now: 1000,
        message: {
          id: 'message:cell-1',
          createdAt: '2026-07-15T02:00:01.000Z',
          role: 'system',
          text,
          requestId: 'req-1',
        },
      },
    );
  }
});

test('buildTuiActionsFromServerMessage omits messages for silent studio progress', () => {
  const event = {
    type: 'studio.progress' as const,
    requestId: 'req-1',
    event: { type: 'turn_started' },
  };

  assert.deepEqual(
    buildTuiActionsFromServerMessage({
      type: 'event',
      requestId: 'req-1',
      event,
    }, {
      now: 1000,
      createMessage: messages(),
    }),
    {
      actions: [{
        type: 'event.received',
        event,
        now: 1000,
      }],
    },
  );
});

test('buildTuiActionsFromServerMessage maps streaming events', () => {
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
    createMessage: messages(),
  });

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
      createMessage: messages(),
    }),
    {
      actions: [{
        type: 'run.interrupting',
        requestId: 'req-1',
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
      createMessage: messages(),
    }),
    {
      actions: [{
        type: 'run.finish',
        requestId: 'req-1',
        messages: [{
          id: 'message:cell-1',
          createdAt: '2026-07-15T02:00:01.000Z',
          role: 'assistant',
          text: '[interrupted]',
          requestId: 'req-1',
        }],
        statusNotice: '已打断',
      }],
    },
  );
});

test('buildTuiActionsFromServerMessage ignores studio control messages', () => {
  // 旧 Ink TUI 不再发起 Studio run(#561),这些回包不可达,不该进时间线。
  for (const message of [
    {
      type: 'studio_response' as const,
      requestId: 'studio-1',
      outcome: 'stopped' as const,
      reply: '',
      reason: 'done enough',
    },
    {
      type: 'studio_error' as const,
      requestId: 'studio-2',
      message: 'planner failed',
    },
  ]) {
    assert.deepEqual(
      buildTuiActionsFromServerMessage(message, { now: 1000, createMessage: messages() }),
      { actions: [] },
    );
  }
});

