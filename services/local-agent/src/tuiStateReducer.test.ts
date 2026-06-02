import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalAgentOperationEvent } from './events/localAgentEvent';
import { createInitialTuiState, createSession, type TuiState } from './tui/state/tuiState';
import {
  selectFocusedActiveRun,
  selectFocusedBusy,
  selectFocusedPendingApproval,
  tuiStateReducer,
} from './tui/state/tuiStateReducer';

function initialState(sessionId = 'chat:pet') {
  return createInitialTuiState(createSession({
    id: sessionId,
    actor: {
      label: 'Paw',
      summary: 'cat',
    },
  }));
}

function startRun(state: TuiState, requestId = 'req-1', sessionId?: string) {
  return tuiStateReducer(state, {
    type: 'run.start',
    ...(sessionId ? { sessionId } : {}),
    requestId,
    kind: 'chat',
    userText: 'hello',
    now: 1000,
    userCell: { id: `${requestId}:user`, timestamp: '10:00:00' },
    statusMessage: '等待回复',
  });
}

test('tuiStateReducer uses completed message text for final assistant history', () => {
  let state = startRun(initialState(), 'req-1');

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'message.delta',
      requestId: 'req-1',
      role: 'assistant',
      text: '我先检查一下仓库状态。',
    },
    now: 1100,
  });
  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'message.delta',
      requestId: 'req-1',
      role: 'assistant',
      text: '检查完毕，下面汇总。',
    },
    now: 1200,
  });

  const activeRun = selectFocusedActiveRun(state);
  assert.equal(activeRun?.assistantDraft, '我先检查一下仓库状态。检查完毕，下面汇总。');
  assert.equal(activeRun?.phase, 'streaming');
  assert.equal(activeRun?.charCount, activeRun?.assistantDraft.length);

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'message.completed',
      requestId: 'req-1',
      role: 'assistant',
      text: '最终回答只应该使用 completed 的内容。',
    },
    now: 1300,
    historyCell: { id: 'assistant-1', timestamp: '10:00:01' },
  });

  const session = state.sessions['chat:pet']!;
  assert.equal(session.activeRun, null);
  assert.equal(state.runRoute['req-1'], undefined);
  assert.deepEqual(session.history.map((item) => [item.kind, item.text]), [
    ['user', 'hello'],
    ['assistant', '最终回答只应该使用 completed 的内容。'],
  ]);
});

test('tuiStateReducer falls back to assistant draft when completed text is empty', () => {
  let state = startRun(initialState(), 'req-1');

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'message.delta',
      requestId: 'req-1',
      role: 'assistant',
      text: '你好',
    },
    now: 1100,
  });

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'message.completed',
      requestId: 'req-1',
      role: 'assistant',
      text: '   ',
    },
    now: 1200,
    historyCell: { id: 'assistant-1', timestamp: '10:00:01' },
  });

  const session = state.sessions['chat:pet']!;
  assert.equal(session.activeRun, null);
  assert.deepEqual(session.history.map((item) => [item.kind, item.text]), [
    ['user', 'hello'],
    ['assistant', '你好'],
  ]);
});

test('tuiStateReducer drops late or unknown requestId events', () => {
  const state = startRun(initialState(), 'req-1');

  const next = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'message.delta',
      requestId: 'unknown',
      role: 'assistant',
      text: 'late',
    },
    now: 1200,
  });

  assert.equal(next, state);
  assert.equal(selectFocusedActiveRun(next)?.assistantDraft, '');
});

test('tuiStateReducer keeps two requestIds from mixing assistant drafts', () => {
  let state = initialState('s1');
  state = {
    ...state,
    sessions: {
      ...state.sessions,
      s2: createSession({ id: 's2' }),
    },
  };
  state = startRun(state, 'req-a', 's1');
  state = startRun(state, 'req-b', 's2');

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'message.delta',
      requestId: 'req-a',
      role: 'assistant',
      text: 'A',
    },
    now: 1100,
  });
  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'message.delta',
      requestId: 'req-b',
      role: 'assistant',
      text: 'B',
    },
    now: 1100,
  });

  assert.equal(state.sessions.s1?.activeRun?.assistantDraft, 'A');
  assert.equal(state.sessions.s2?.activeRun?.assistantDraft, 'B');
});

test('tuiStateReducer tracks operation lifecycle and terminal summaries', () => {
  let state = startRun(initialState(), 'req-1');
  const started: LocalAgentOperationEvent = {
    type: 'operation',
    requestId: 'req-1',
    phase: 'started',
    operation: {
      id: 'tool-1',
      kind: 'shell',
      title: 'Shell',
      target: 'npm test',
    },
  };

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: started,
    now: 1200,
  });

  let activeRun = selectFocusedActiveRun(state);
  assert.equal(activeRun?.phase, 'using_tool');
  assert.deepEqual(activeRun?.activeOperations.map((operation) => operation.key), ['tool-1']);

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      ...started,
      phase: 'updated',
      operation: {
        ...started.operation,
        summary: 'running',
      },
    },
    now: 1300,
  });

  activeRun = selectFocusedActiveRun(state);
  assert.equal(activeRun?.activeOperations[0]?.detail, 'npm test · running');

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      ...started,
      phase: 'completed',
      operation: {
        ...started.operation,
        summary: 'ok',
      },
    },
    now: 1400,
    historyCell: { id: 'op-complete' },
  });

  activeRun = selectFocusedActiveRun(state);
  assert.equal(activeRun?.activeOperations.length, 0);
  assert.equal(state.sessions['chat:pet']?.history.at(-1)?.kind, 'system');
  assert.equal(state.sessions['chat:pet']?.history.at(-1)?.text, 'Shell：npm test · ok');
});

test('tuiStateReducer handles human review and interrupt state', () => {
  let state = startRun(initialState(), 'req-1');

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'human_review.requested',
      requestId: 'req-1',
      prompt: 'Approve?',
      payload: { kind: 'approval' },
      actor: { petId: 'pet-a' },
    },
    now: 1200,
  });

  assert.equal(selectFocusedBusy(state), false);
  assert.equal(selectFocusedActiveRun(state)?.phase, 'waiting_human');
  assert.deepEqual(selectFocusedPendingApproval(state), {
    kind: 'approval',
    requestId: 'req-1',
    prompt: 'Approve?',
    payload: { kind: 'approval' },
    petId: 'pet-a',
  });
  assert.equal(state.connection.message, '等待你的决定(pet-a)');

  state = tuiStateReducer(state, {
    type: 'review.response.start',
    requestId: 'req-1',
    message: '批准',
    now: 1300,
    userCell: { id: 'review-response' },
    statusMessage: '提交确认',
  });

  assert.equal(selectFocusedBusy(state), true);
  assert.equal(selectFocusedActiveRun(state)?.phase, 'thinking');
  assert.equal(selectFocusedPendingApproval(state), null);

  state = tuiStateReducer(state, {
    type: 'run.interrupting',
    requestId: 'req-1',
    statusMessage: '正在打断',
  });

  assert.equal(selectFocusedActiveRun(state)?.phase, 'interrupting');
  assert.equal(state.connection.message, '正在打断');
});

test('tuiStateReducer finishes error and studio control messages', () => {
  let state = startRun(initialState(), 'chat-req');
  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'error',
      requestId: 'chat-req',
      message: 'boom',
    },
    now: 1200,
    historyCell: { id: 'chat-error' },
  });

  assert.equal(selectFocusedActiveRun(state), null);
  assert.equal(state.connection.message, '出错，已恢复输入');
  assert.equal(state.sessions['chat:pet']?.history.at(-1)?.text, '出错：boom');

  state = startRun(state, 'studio-req');
  state = tuiStateReducer(state, {
    type: 'server.studio_response',
    requestId: 'studio-req',
    outcome: 'stopped',
    reply: '',
    reason: 'done enough',
    historyCell: { id: 'studio-empty' },
    stoppedReasonCell: { id: 'studio-stopped' },
    statusMessage: '就绪',
  });

  assert.equal(selectFocusedActiveRun(state), null);
  assert.deepEqual(state.sessions['chat:pet']?.history.slice(-2).map((item) => item.text), [
    '[studio] turn stopped (无最终输出)',
    '[studio] stopped: done enough',
  ]);

  state = startRun(state, 'studio-error');
  state = tuiStateReducer(state, {
    type: 'server.studio_error',
    requestId: 'studio-error',
    message: 'planner failed',
    historyCell: { id: 'studio-error-cell' },
    statusMessage: 'Studio 出错，已恢复输入',
  });

  assert.equal(selectFocusedActiveRun(state), null);
  assert.equal(state.connection.message, 'Studio 出错，已恢复输入');
  assert.equal(state.sessions['chat:pet']?.history.at(-1)?.text, '[studio 出错] planner failed');
});
