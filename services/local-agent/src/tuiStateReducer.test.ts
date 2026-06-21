import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalAgentOperationEvent } from './events/localAgentEvent';
import { TUI_CORE_TARGET_ACTIONS } from './tui/contracts/tuiCoreContract';
import { createInitialTuiState, createSession, type TuiState } from './tui/state/tuiState';
import {
  selectFocusedActiveOperations,
  selectFocusedActiveRun,
  selectFocusedBusy,
  selectFocusedPendingApproval,
  selectFocusedTimeline,
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

function timelineMessageText(state: TuiState, sessionId: string, entryId: string) {
  const entry = state.sessions[sessionId]?.timeline.find((entry) => entry.id === entryId);
  return entry?.type === 'message' ? entry.text : undefined;
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
  assert.equal(activeRun?.phase, 'streaming');
  assert.equal(activeRun?.charCount, '我先检查一下仓库状态。检查完毕，下面汇总。'.length);
  assert.equal(
    timelineMessageText(state, 'chat:pet', 'req-1:assistant:0'),
    '我先检查一下仓库状态。检查完毕，下面汇总。',
  );

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
  assert.deepEqual(session.timeline.map((entry) => (
    entry.type === 'message'
      ? [entry.type, entry.role, entry.status, entry.text]
      : [entry.type]
  )), [
    ['message', 'user', 'completed', 'hello'],
    ['message', 'assistant', 'completed', '最终回答只应该使用 completed 的内容。'],
  ]);
});

test('tuiStateReducer records composer prompt history only for run starts', () => {
  let state = initialState();

  state = tuiStateReducer(state, {
    type: 'run.start',
    requestId: 'req-1',
    kind: 'chat',
    userText: ' hello ',
    now: 1000,
    userCell: { id: 'req-1:user' },
    statusMessage: '等待回复',
  });
  assert.deepEqual(state.input.history.entries, ['hello']);
  assert.equal(state.input.text, '');
  assert.equal(state.input.cursorOffset, 0);

  state = tuiStateReducer(state, {
    type: 'run.start',
    requestId: 'req-2',
    kind: 'chat',
    userText: 'hello',
    now: 2000,
    userCell: { id: 'req-2:user' },
    statusMessage: '等待回复',
  });
  assert.deepEqual(state.input.history.entries, ['hello']);

  state = tuiStateReducer(state, {
    type: 'review.response.resume',
    requestId: 'req-2',
    message: 'approval text',
    now: 3000,
    userCell: { id: 'req-2:review' },
    statusMessage: '继续执行',
  });
  assert.deepEqual(state.input.history.entries, ['hello']);
});

test('tuiStateReducer navigates composer prompt history and restores draft', () => {
  let state = initialState();

  state = startRun(state, 'req-1');
  state = tuiStateReducer(state, {
    type: 'run.start',
    requestId: 'req-2',
    kind: 'chat',
    userText: 'second',
    now: 2000,
    userCell: { id: 'req-2:user' },
    statusMessage: '等待回复',
  });
  state = tuiStateReducer(state, { type: 'input.set', value: 'draft' });

  state = tuiStateReducer(state, { type: 'input.history.navigate', direction: 'previous' });
  assert.equal(state.input.text, 'second');
  assert.equal(state.input.cursorOffset, 'second'.length);

  state = tuiStateReducer(state, { type: 'input.history.navigate', direction: 'previous' });
  assert.equal(state.input.text, 'hello');

  state = tuiStateReducer(state, { type: 'input.history.navigate', direction: 'next' });
  assert.equal(state.input.text, 'second');

  state = tuiStateReducer(state, { type: 'input.history.navigate', direction: 'next' });
  assert.equal(state.input.text, 'draft');
  assert.equal(state.input.history.selectedIndex, null);
});

test('tuiStateReducer preserves engine textarea state and clears transient state on host changes', () => {
  let state = tuiStateReducer(initialState(), {
    type: 'input.apply',
    value: {
      text: 'hello',
      cursorOffset: 5,
      selection: { anchorOffset: 1, focusOffset: 4 },
      editHistory: { undo: [{ text: 'he', cursorOffset: 2 }], redo: [] },
      preferredColumn: 3,
    },
  });

  assert.deepEqual(state.input.selection, { anchorOffset: 1, focusOffset: 4 });
  assert.deepEqual(state.input.editHistory, { undo: [{ text: 'he', cursorOffset: 2 }], redo: [] });
  assert.equal(state.input.preferredColumn, 3);

  state = tuiStateReducer(state, { type: 'input.set', value: 'draft' });
  assert.equal(state.input.selection, undefined);
  assert.equal(state.input.editHistory, undefined);
  assert.equal(state.input.preferredColumn, undefined);

  state = tuiStateReducer(state, {
    type: 'input.apply',
    value: {
      text: 'second',
      cursorOffset: 6,
      selection: { anchorOffset: 0, focusOffset: 6 },
      editHistory: { undo: [{ text: 'draft', cursorOffset: 5 }], redo: [] },
      preferredColumn: 2,
    },
  });
  state = tuiStateReducer(state, {
    type: 'run.start',
    requestId: 'req-transient',
    kind: 'chat',
    userText: 'second',
    now: 1000,
    userCell: { id: 'req-transient:user' },
    statusMessage: '等待回复',
  });
  assert.equal(state.input.selection, undefined);
  assert.equal(state.input.editHistory, undefined);
  assert.equal(state.input.preferredColumn, undefined);
});

test('tuiStateReducer infers usage context window from runtime when missing', () => {
  let state = startRun(initialState(), 'req-1');
  state = tuiStateReducer(state, {
    type: 'session.set_runtime',
    runtime: { contextWindow: 1024 },
  });
  const usage = {
    inputTokens: 50,
    outputTokens: 20,
    totalTokens: 70,
  };

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'message.completed',
      requestId: 'req-1',
      role: 'assistant',
      text: '回答完成',
      usage,
    },
    now: 1300,
    historyCell: { id: 'assistant-1', timestamp: '10:00:01' },
  });

  const session = state.sessions['chat:pet']!;
  assert.equal(session.activeRun, null);
  assert.deepEqual(session.tokenUsage, {
    ...usage,
    contextWindow: 1024,
  });
  assert.equal(session.runtime.contextWindow, 1024);
});

test('tuiStateReducer falls back to assistant timeline text when completed text is empty', () => {
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

test('tuiStateReducer displays subagent deltas in timeline without legacy draft state', () => {
  let state = startRun(initialState(), 'req-1');

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'subagent.message.delta',
      requestId: 'req-1',
      text: '先检查文件',
    },
    now: 1100,
  });
  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'subagent.message.delta',
      requestId: 'req-1',
      text: '，再整理结果。',
    },
    now: 1200,
  });

  assert.equal(selectFocusedActiveRun(state)?.phase, 'streaming');
  assert.equal(selectFocusedActiveRun(state)?.charCount, '先检查文件，再整理结果。'.length);
  assert.deepEqual(selectFocusedTimeline(state).at(-1), {
    id: 'req-1:subagent-output',
    type: 'message',
    role: 'subagent',
    requestId: 'req-1',
    text: '先检查文件，再整理结果。',
    status: 'streaming',
  });

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'message.completed',
      requestId: 'req-1',
      role: 'assistant',
      text: '最终答复',
    },
    now: 1300,
    historyCell: { id: 'assistant-1', timestamp: '10:00:01' },
  });

  assert.deepEqual(state.sessions['chat:pet']?.history.map((item) => [item.kind, item.text]), [
    ['user', 'hello'],
    ['assistant', '最终答复'],
  ]);
  const subagentEntry = state.sessions['chat:pet']?.timeline.find((entry) => entry.id === 'req-1:subagent-output');
  assert.equal(subagentEntry?.type, 'message');
  assert.equal(subagentEntry?.type === 'message' && subagentEntry.role === 'subagent'
    ? subagentEntry.status
    : null, 'completed');
});

test('tuiStateReducer stores usage on completed message', () => {
  let state = startRun(initialState(), 'req-1');
  const usage = {
    inputTokens: 50,
    outputTokens: 20,
    totalTokens: 70,
    contextWindow: 100,
  };

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'message.completed',
      requestId: 'req-1',
      role: 'assistant',
      text: '回答完成',
      usage,
    },
    now: 1300,
    historyCell: { id: 'assistant-1', timestamp: '10:00:01' },
  });

  const session = state.sessions['chat:pet']!;
  assert.equal(session.activeRun, null);
  assert.deepEqual(session.tokenUsage, usage);
});

test('tuiStateReducer clears session token usage when replacing or clearing history', () => {
  let state = initialState();
  state = {
    ...state,
    sessions: {
      ...state.sessions,
      'chat:pet': {
        ...state.sessions['chat:pet']!,
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
      },
    },
  };

  state = tuiStateReducer(state, {
    type: 'session.replace_history',
    history: [{ id: 'restored', kind: 'assistant', text: 'restored' }],
  });

  assert.equal(state.sessions['chat:pet']?.tokenUsage, null);

  state = {
    ...state,
    sessions: {
      ...state.sessions,
      'chat:pet': {
        ...state.sessions['chat:pet']!,
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
      },
    },
  };

  state = tuiStateReducer(state, {
    type: 'session.clear',
  });

  assert.equal(state.sessions['chat:pet']?.tokenUsage, null);
});

test('tuiStateReducer loads authoritative session snapshots', () => {
  let state = initialState('chat:pet');
  state = {
    ...state,
    runRoute: {
      'old-req': 'chat:pet',
      'other-req': 'chat:other',
    },
    sessions: {
      ...state.sessions,
      'chat:other': createSession({ id: 'chat:other' }),
      'chat:pet': {
        ...state.sessions['chat:pet']!,
        runtime: { model: 'old-model', cwd: '/old' },
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
      },
    },
  };

  state = tuiStateReducer(state, {
    type: TUI_CORE_TARGET_ACTIONS.sessionSnapshotLoaded,
    source: 'startup',
    snapshot: {
      sessionId: 'chat:pet',
      kind: 'chat',
      timeline: [
        {
          id: 'history:user-1',
          type: 'message',
          role: 'user',
          text: 'hello',
          status: 'completed',
          source: 'checkpoint',
          requestId: 'req-1',
        },
        {
          id: 'history:assistant-1',
          type: 'message',
          role: 'assistant',
          text: 'hi',
          status: 'completed',
          source: 'checkpoint',
          requestId: 'req-1',
        },
      ],
      runs: [{
        requestId: 'req-1',
        sessionId: 'chat:pet',
        kind: 'chat',
        phase: 'streaming',
        timelineEntryIds: ['history:user-1'],
        startedAt: 1000,
      }],
      activeRunId: 'req-1',
      runtime: {
        model: 'new-model',
        contextWindow: 1000,
      },
      tokenUsage: {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
      },
    },
  });

  const session = state.sessions['chat:pet']!;
  assert.equal(state.focusedSessionId, 'chat:pet');
  assert.deepEqual(session.history.map((item) => [item.kind, item.text]), [
    ['user', 'hello'],
    ['assistant', 'hi'],
  ]);
  assert.deepEqual(session.timeline.map((entry) => [entry.id, entry.type]), [
    ['history:user-1', 'message'],
    ['history:assistant-1', 'message'],
  ]);
  assert.equal(session.runtime.model, 'new-model');
  assert.equal(session.runtime.cwd, '/old');
  assert.equal(session.runtime.contextWindow, 1000);
  assert.deepEqual(session.tokenUsage, {
    inputTokens: 20,
    outputTokens: 10,
    totalTokens: 30,
  });
  assert.equal(session.activeRun?.requestId, 'req-1');
  assert.equal(session.activeRun?.phase, 'streaming');
  assert.equal(state.runRoute['req-1'], 'chat:pet');
  assert.equal(state.runRoute['old-req'], undefined);
  assert.equal(state.runRoute['other-req'], 'chat:other');
});

test('tuiStateReducer clears run routes for the cleared session', () => {
  let state = initialState('chat:pet');
  state = {
    ...state,
    sessions: {
      ...state.sessions,
      'chat:other': createSession({ id: 'chat:other' }),
    },
  };
  state = startRun(state, 'req-main');
  state = startRun(state, 'req-other', 'chat:other');

  state = tuiStateReducer(state, {
    type: 'session.clear',
  });

  assert.equal(state.runRoute['req-main'], undefined);
  assert.equal(state.runRoute['req-other'], 'chat:other');
  assert.equal(state.sessions['chat:pet']?.history.length, 0);
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
  assert.equal(selectFocusedTimeline(next).some((entry) => entry.type === 'message' && entry.role === 'assistant'), false);
});

test('tuiStateReducer keeps two requestIds from mixing assistant timeline entries', () => {
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

  assert.equal(timelineMessageText(state, 's1', 'req-a:assistant:0'), 'A');
  assert.equal(timelineMessageText(state, 's2', 'req-b:assistant:0'), 'B');
});

test('tuiStateReducer tracks operation lifecycle in timeline without terminal history rows', () => {
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
  assert.deepEqual(activeRun?.timelineEntryIds, ['history:req-1:user', 'req-1:operation:tool-1']);
  assert.equal(selectFocusedTimeline(state).at(-1)?.id, 'req-1:operation:tool-1');
  assert.equal(selectFocusedTimeline(state).at(-1)?.type, 'operation');
  assert.deepEqual(selectFocusedActiveOperations(state), [{
    name: 'tool-1',
    label: 'Shell',
    detail: 'npm test',
    startedAt: 1200,
  }]);

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
  assert.deepEqual(selectFocusedActiveOperations(state), [{
    name: 'tool-1',
    label: 'Shell',
    detail: 'npm test · running',
    startedAt: 1200,
  }]);
  const updatedTimelineEntry = selectFocusedTimeline(state).find((entry) => entry.id === 'req-1:operation:tool-1');
  assert.equal(updatedTimelineEntry?.type === 'operation' ? updatedTimelineEntry.summary : undefined, 'running');

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
  assert.deepEqual(selectFocusedActiveOperations(state), []);
  assert.deepEqual(state.sessions['chat:pet']?.history.map((entry) => [entry.kind, entry.text]), [
    ['user', 'hello'],
  ]);
  assert.equal(selectFocusedTimeline(state).filter((entry) => entry.id === 'req-1:operation:tool-1').length, 1);
  const completedTimelineEntry = selectFocusedTimeline(state).find((entry) => entry.id === 'req-1:operation:tool-1');
  assert.equal(completedTimelineEntry?.type === 'operation' ? completedTimelineEntry.phase : undefined, 'completed');
  assert.equal(completedTimelineEntry?.type === 'operation' ? completedTimelineEntry.summary : undefined, 'ok');
  assert.equal(selectFocusedTimeline(state).some((entry) => entry.id === 'history:op-complete'), false);
});

test('tuiStateReducer handles human review and interrupt state', () => {
  let state = startRun(initialState(), 'req-1');

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'human_review.requested',
      requestId: 'req-1',
      review: {
        id: 'review-1',
        schemaVersion: 1,
        view: { kind: 'plain', body: 'Approve?' },
        options: [],
      },
      actor: { petId: 'pet-a' },
    },
    now: 1200,
  });

  assert.equal(selectFocusedBusy(state), false);
  assert.equal(selectFocusedActiveRun(state)?.phase, 'waiting_human');
  assert.deepEqual(selectFocusedPendingApproval(state), {
    requestId: 'req-1',
    review: {
      id: 'review-1',
      schemaVersion: 1,
      view: { kind: 'plain', body: 'Approve?' },
      options: [],
    },
    petId: 'pet-a',
  });
  assert.equal(state.connection.message, '等待你的决定(pet-a)');
  assert.deepEqual(selectFocusedTimeline(state).at(-1), {
    id: 'req-1:review:review-1',
    type: 'review',
    requestId: 'req-1',
    reviewId: 'review-1',
    status: 'waiting',
  });

  const activeRunBefore = selectFocusedActiveRun(state);
  state = tuiStateReducer(state, {
    type: 'review.response.resume',
    requestId: 'req-1',
    message: '批准',
    now: 1300,
    userCell: { id: 'review-response' },
    statusMessage: '提交确认',
  });

  assert.equal(selectFocusedBusy(state), true);
  assert.equal(selectFocusedActiveRun(state)?.phase, 'thinking');
  // resume preserves the same run identity (same startedAt, same requestId)
  assert.equal(selectFocusedActiveRun(state)?.requestId, 'req-1');
  assert.equal(selectFocusedActiveRun(state)?.startedAt, activeRunBefore?.startedAt);
  assert.equal(selectFocusedPendingApproval(state), null);
  const answeredReview = selectFocusedTimeline(state).find((entry) => entry.id === 'req-1:review:review-1');
  assert.equal(answeredReview?.type === 'review' ? answeredReview.status : undefined, 'answered');
  assert.deepEqual(selectFocusedTimeline(state).at(-1), {
    id: 'history:review-response',
    type: 'message',
    role: 'user',
    text: '批准',
    status: 'completed',
  });

  state = tuiStateReducer(state, {
    type: 'run.interrupting',
    requestId: 'req-1',
    statusMessage: '正在打断',
  });

  assert.equal(selectFocusedActiveRun(state)?.phase, 'interrupting');
  assert.equal(state.connection.message, '正在打断');
});

test('tuiStateReducer clears pending review when interrupting human review', () => {
  let state = startRun(initialState(), 'req-1');

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'human_review.requested',
      requestId: 'req-1',
      review: {
        id: 'review-1',
        schemaVersion: 1,
        view: { kind: 'plain', body: 'Approve?' },
        options: [],
      },
    },
    now: 1200,
  });
  state = tuiStateReducer(state, {
    type: 'run.interrupting',
    requestId: 'req-1',
    statusMessage: '正在打断',
  });

  assert.equal(selectFocusedActiveRun(state)?.phase, 'interrupting');
  assert.equal(selectFocusedPendingApproval(state), null);
});

test('tuiStateReducer review.response.resume falls back to focused session when route is missing', () => {
  let state = startRun(initialState(), 'req-1');
  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'human_review.requested',
      requestId: 'req-1',
      review: {
        id: 'review-1',
        schemaVersion: 1,
        view: { kind: 'plain', body: 'Approve?' },
        options: [],
      },
      actor: { petId: 'pet-a' },
    },
    now: 1200,
  });

  state = {
    ...state,
    runRoute: {},
  };

  state = tuiStateReducer(state, {
    type: 'review.response.resume',
    requestId: 'req-1',
    message: '批准',
    now: 1300,
    userCell: { id: 'review-response' },
    statusMessage: '提交确认',
  });

  const answeredReview = selectFocusedTimeline(state).find((entry) => entry.id === 'req-1:review:review-1');
  assert.equal(answeredReview?.type === 'review' ? answeredReview.status : undefined, 'answered');
  assert.equal(state.runRoute['req-1'], 'chat:pet');
  assert.equal(selectFocusedPendingApproval(state), null);
  assert.equal(selectFocusedActiveRun(state)?.phase, 'thinking');
});

test('tuiStateReducer accepts canonical human review specs without legacy payload', () => {
  let state = startRun(initialState(), 'req-1');

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'human_review.requested',
      requestId: 'req-1',
      review: {
        id: 'review-1',
        schemaVersion: 1,
        view: {
          kind: 'plain',
          title: 'Needs approval',
          body: 'Run command?',
        },
        options: [{
          id: 'approve',
          label: 'Approve',
          decision: { type: 'approve' },
        }],
      },
    },
    now: 1200,
  });

  assert.deepEqual(selectFocusedPendingApproval(state), {
    requestId: 'req-1',
    review: {
      id: 'review-1',
      schemaVersion: 1,
      view: {
        kind: 'plain',
        title: 'Needs approval',
        body: 'Run command?',
      },
      options: [{
        id: 'approve',
        label: 'Approve',
        decision: { type: 'approve' },
      }],
    },
  });
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
