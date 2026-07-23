import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalAgentOperationEvent } from './events/localAgentRuntimeEvent';
import type {
  LocalAgentMessageEntry,
  LocalAgentRunView,
  LocalAgentSessionSnapshot,
} from './localAgentSession';
import { createInitialTuiState, createSession, type TuiState } from './tui/state/tuiState';
import {
  selectFocusedActiveOperations,
  selectFocusedActiveRun,
  selectFocusedBusy,
  selectFocusedPendingApproval,
  selectFocusedPendingUi,
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

function activeRun(state: TuiState, requestId: string) {
  return Object.values(state.sessions).find((session) => session.activeRun?.requestId === requestId)?.activeRun;
}

function activeRunActivity(run: LocalAgentRunView | null | undefined) {
  return run?.state === 'running' ? run.activity : undefined;
}

function activeReviewAction(run: LocalAgentRunView | null | undefined) {
  return run?.state === 'waiting_review' ? run.reviewAction : null;
}

function sessionSnapshot(input: {
  sessionId: string;
  kind: 'chat' | 'studio';
  timeline: LocalAgentSessionSnapshot['session']['timeline'];
  activeRun?: LocalAgentRunView | null;
  runtime?: LocalAgentSessionSnapshot['session']['runtime'];
  tokenUsage?: LocalAgentSessionSnapshot['session']['tokenUsage'];
  sessionTokenUsage?: LocalAgentSessionSnapshot['session']['sessionTokenUsage'];
}): LocalAgentSessionSnapshot {
  return {
    version: 3,
    session: {
      sessionId: input.sessionId,
      kind: input.kind,
      timeline: input.timeline,
      activeRun: input.activeRun ?? null,
      ...(input.runtime ? { runtime: input.runtime } : {}),
      ...(input.tokenUsage ? { tokenUsage: input.tokenUsage } : {}),
      ...(input.sessionTokenUsage ? { sessionTokenUsage: input.sessionTokenUsage } : {}),
    },
  };
}

function startRun(state: TuiState, requestId = 'req-1', sessionId?: string) {
  return tuiStateReducer(state, {
    type: 'run.start',
    ...(sessionId ? { sessionId } : {}),
    requestId,
    kind: 'chat',
    message: {
      id: `message:${requestId}:user`,
      role: 'user',
      text: 'hello',
      requestId,
      createdAt: new Date(1000).toISOString(),
    },
    now: 1000,
  });
}

function timelineMessageText(state: TuiState, sessionId: string, entryId: string) {
  const entry = state.sessions[sessionId]?.timeline.find((entry) => entry.id === entryId);
  return entry?.type === 'message' ? entry.text : undefined;
}

function transcriptTimeline(state: TuiState, sessionId = 'chat:pet') {
  return state.sessions[sessionId]?.timeline
    .filter((entry) =>
      entry.type === 'message' && (entry.role === 'user' || entry.role === 'assistant'))
    .map((entry) => [
      entry.type === 'message' ? entry.role : 'system',
      entry.type === 'message' ? entry.text : '',
    ]) ?? [];
}

function timelineMessagesByRole(state: TuiState, role: 'system' | 'subagent', sessionId = 'chat:pet') {
  return state.sessions[sessionId]?.timeline.filter((entry): entry is LocalAgentMessageEntry =>
    entry.type === 'message' && entry.role === role) ?? [];
}

test('tuiStateReducer initializes reducer-owned UI owner state', () => {
  const state = initialState();

  assert.deepEqual(state.ui, {
    composerTarget: 'chat',
    studioConversationId: null,
    externalEditorOpen: false,
  });
});

test('tuiStateReducer updates composer target and external editor owner state', () => {
  let state = initialState();

  state = tuiStateReducer(state, {
    type: 'ui.composer_target.set',
    composerTarget: 'studio',
    studioConversationId: 'conversation-1',
  });
  state = tuiStateReducer(state, {
    type: 'ui.external_editor.set_open',
    open: true,
  });

  assert.equal(state.ui.composerTarget, 'studio');
  assert.equal(state.ui.studioConversationId, 'conversation-1');
  assert.equal(state.ui.externalEditorOpen, true);

  state = tuiStateReducer(state, { type: 'ui.composer_target.reset' });

  assert.equal(state.ui.composerTarget, 'chat');
  assert.equal(state.ui.studioConversationId, null);
  assert.equal(state.ui.externalEditorOpen, true);
});

test('tuiStateReducer keeps transport connection detail separate from run status', () => {
  let state = initialState();
  state = tuiStateReducer(state, {
    type: 'connection.set',
    status: 'ready',
    detail: 'transport detail',
  });

  state = startRun(state, 'req-1');
  state = tuiStateReducer(state, {
    type: 'run.interrupting',
    requestId: 'req-1',
  });

  assert.deepEqual(state.connection, { status: 'ready', detail: 'transport detail' });
  assert.equal(state.statusNotice, null);
  assert.equal(selectFocusedActiveRun(state)?.state, 'interrupting');
});

test('tuiStateReducer keeps background session events out of the focused status notice', () => {
  let state = initialState();
  state.statusNotice = 'focused notice';
  state.sessions['chat:other'] = createSession({ id: 'chat:other' });

  state = startRun(state, 'req-other', 'chat:other');
  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'error',
      requestId: 'req-other',
      message: 'background failure',
    },
    now: 1200,
  });

  assert.equal(state.statusNotice, 'focused notice');
  assert.equal(state.sessions['chat:other']?.activeRun, null);
});

test('tuiStateReducer handles streaming chat completion with token usage', () => {
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

  const focusedRun = selectFocusedActiveRun(state);
  assert.equal(activeRunActivity(focusedRun), 'streaming');
  assert.equal(state.sessions['chat:pet']?.activeRun, focusedRun);
  assert.equal(state.sessions['chat:pet']?.kind, 'chat');
  assert.equal(selectFocusedPendingUi(state)?.charCount, '我先检查一下仓库状态。检查完毕，下面汇总。'.length);
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
      usage,
    },
    now: 1300,
  });

  const session = state.sessions['chat:pet']!;
  assert.equal(session.activeRun, null);
  assert.equal(activeRun(state, 'req-1'), undefined);
  assert.deepEqual(session.tokenUsage, usage);
  assert.deepEqual(session.sessionTokenUsage, {
    ...usage,
    scope: 'session',
  });
  assert.deepEqual(session.timeline.map((entry) => (
    entry.type === 'message' && entry.role === 'assistant'
      ? [entry.createdAt, entry.updatedAt]
      : []
  )).filter((item) => item.length > 0), [
    [new Date(1100).toISOString(), new Date(1300).toISOString()],
  ]);
  assert.deepEqual(transcriptTimeline(state), [
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

test('tuiStateReducer finalizes completed messages from the session active run', () => {
  let state = startRun(initialState(), 'req-1');

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'message.completed',
      requestId: 'req-1',
      role: 'assistant',
      text: 'missed final reply',
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
      },
    },
    now: 1300,
  });

  const session = state.sessions['chat:pet']!;
  assert.equal(activeRun(state, 'req-1'), undefined);
  assert.deepEqual(transcriptTimeline(state), [
    ['user', 'hello'],
    ['assistant', 'missed final reply'],
  ]);
  assert.deepEqual(session.tokenUsage, {
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
  });
});

test('tuiStateReducer finalizes completed messages after the active run is cleared', () => {
  let state = startRun(initialState(), 'req-1');
  state = {
    ...state,
    sessions: {
      ...state.sessions,
      'chat:pet': {
        ...state.sessions['chat:pet']!,
        activeRun: null,
      },
    },
  };

  assert.equal((state.sessions['chat:pet']?.activeRun?.requestId ?? null), null);

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'message.completed',
      requestId: 'req-1',
      role: 'assistant',
      text: 'completed after pointer cleanup',
    },
    now: 1300,
  });

  assert.equal(activeRun(state, 'req-1'), undefined);
  assert.equal((state.sessions['chat:pet']?.activeRun?.requestId ?? null), null);
  assert.deepEqual(transcriptTimeline(state), [
    ['user', 'hello'],
    ['assistant', 'completed after pointer cleanup'],
  ]);
});

test('tuiStateReducer recovers completed messages from timeline ownership when the active run is missing', () => {
  let state = startRun(initialState(), 'req-1');
  state = {
    ...state,
    sessions: {
      ...state.sessions,
      'chat:pet': {
        ...state.sessions['chat:pet']!,
        activeRun: null,
      },
    },
  };

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'message.completed',
      requestId: 'req-1',
      role: 'assistant',
      text: 'final answer recovered from completed event',
      usage: {
        inputTokens: 4,
        outputTokens: 5,
        totalTokens: 9,
      },
    },
    now: 1300,
  });

  assert.equal((state.sessions['chat:pet']?.activeRun?.requestId ?? null), null);
  assert.deepEqual(transcriptTimeline(state), [
    ['user', 'hello'],
    ['assistant', 'final answer recovered from completed event'],
  ]);
  assert.deepEqual(state.sessions['chat:pet']?.tokenUsage, {
    inputTokens: 4,
    outputTokens: 5,
    totalTokens: 9,
  });
});

test('tuiStateReducer keeps the current review draft when an older request completes late', () => {
  let state = startRun(initialState(), 'req-old');
  state = {
    ...state,
    sessions: {
      ...state.sessions,
      'chat:pet': {
        ...state.sessions['chat:pet']!,
        activeRun: null,
      },
    },
  };
  state = startRun(state, 'req-new');
  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'human_review.requested',
      requestId: 'req-new',
      review: {
        id: 'review-new',
        schemaVersion: 1,
        view: { kind: 'plain', body: 'Approve the new run?' },
        options: [],
      },
    },
    now: 1200,
  });

  const actionId = 'request:req-new:reviews:review-new';
  assert.deepEqual(state.reviewDrafts[actionId], {
    actionId,
    decisions: [],
  });

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'message.completed',
      requestId: 'req-old',
      role: 'assistant',
      text: 'late old answer',
    },
    now: 1300,
  });

  assert.equal(state.sessions['chat:pet']?.activeRun?.requestId, 'req-new');
  assert.equal(state.sessions['chat:pet']?.activeRun?.state, 'waiting_review');
  assert.deepEqual(state.reviewDrafts[actionId], {
    actionId,
    decisions: [],
  });
  assert.equal(selectFocusedPendingApproval(state)?.actionId, actionId);
});

test('tuiStateReducer records composer prompt history only for run starts', () => {
  let state = initialState();

  state = tuiStateReducer(state, {
    type: 'run.start',
    requestId: 'req-1',
    kind: 'chat',
    message: { role: 'user', text: ' hello ' },
    now: 1000,
  });
  assert.deepEqual(state.input.history.entries, ['hello']);
  assert.equal(state.input.text, '');
  assert.equal(state.input.cursorOffset, 0);

  state = tuiStateReducer(state, {
    type: 'run.start',
    requestId: 'req-2',
    kind: 'chat',
    message: { role: 'user', text: 'hello' },
    now: 2000,
  });
  assert.deepEqual(state.input.history.entries, ['hello']);

  state = tuiStateReducer(state, {
    type: 'review.resolution.sent',
    requestId: 'req-2',
    actionId: 'request:req-2:reviews:unknown',
    decision: { reviewId: 'review-2', selectedOptionId: 'approve' },
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
    message: { role: 'user', text: 'second' },
    now: 2000,
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
    message: { role: 'user', text: 'second' },
    now: 1000,
  });
  assert.equal(state.input.selection, undefined);
  assert.equal(state.input.editHistory, undefined);
  assert.equal(state.input.preferredColumn, undefined);
});

test('tuiStateReducer infers usage context window from runtime when missing', () => {
  let state = startRun(initialState(), 'req-1');
  state = tuiStateReducer(state, {
    type: 'session.configured',
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
  });

  const session = state.sessions['chat:pet']!;
  assert.equal(session.activeRun, null);
  assert.deepEqual(transcriptTimeline(state), [
    ['user', 'hello'],
    ['assistant', '你好'],
  ]);
});

test('tuiStateReducer keeps completed subagent message blocks interleaved with operations', () => {
  let state = startRun(initialState(), 'req-1');

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'subagent.message.completed',
      requestId: 'req-1',
      messageId: 'child-1',
      namespace: ['general:t1', 'model_request:t2'],
      text: '先检查文件',
    },
    now: 1100,
  });
  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'operation',
      requestId: 'req-1',
      phase: 'started',
      operation: {
        id: 'tool-1',
        kind: 'shell',
      },
    },
    now: 1150,
  });
  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'operation',
      requestId: 'req-1',
      phase: 'completed',
      operation: {
        id: 'tool-1',
        kind: 'shell',
      },
    },
    now: 1175,
  });
  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'subagent.message.completed',
      requestId: 'req-1',
      messageId: 'child-2',
      namespace: ['general:t1', 'model_request:t2'],
      text: '，再整理结果。',
    },
    now: 1200,
  });

  assert.equal(activeRunActivity(selectFocusedActiveRun(state)), 'streaming');
  assert.equal(selectFocusedPendingUi(state)?.charCount, '先检查文件，再整理结果。'.length);
  assert.deepEqual(
    selectFocusedTimeline(state).map((entry) => [entry.type, entry.id]),
    [
      ['message', 'message:req-1:user'],
      ['message', 'req-1:subagent:general:t1|model_request:t2:child-1'],
      ['operation', 'req-1:operation:tool-1'],
      ['message', 'req-1:subagent:general:t1|model_request:t2:child-2'],
    ],
  );
  assert.deepEqual(
    timelineMessagesByRole(state, 'subagent').map((entry) => [entry.text, entry.status]),
    [
      ['先检查文件', 'completed'],
      ['，再整理结果。', 'completed'],
    ],
  );

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'message.completed',
      requestId: 'req-1',
      role: 'assistant',
      text: '最终答复',
    },
    now: 1300,
  });

  assert.deepEqual(transcriptTimeline(state), [
    ['user', 'hello'],
    ['assistant', '最终答复'],
  ]);
  assert.equal(
    timelineMessagesByRole(state, 'subagent').every((entry) => entry.status === 'completed'),
    true,
  );
});

test('tuiStateReducer orders subagent messages by live event arrival', () => {
  let state = startRun(initialState(), 'req-1');

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'message.delta',
      requestId: 'req-1',
      role: 'assistant',
      text: '主答复草稿',
    },
    now: 1100,
  });
  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'subagent.message.completed',
      requestId: 'req-1',
      messageId: 'child-1',
      namespace: [],
      text: 'subagent announce',
    },
    now: 1200,
  });

  assert.deepEqual(
    selectFocusedTimeline(state).map((entry) => entry.id),
    [
      'message:req-1:user',
      'req-1:assistant:0',
      'req-1:subagent:child-1',
    ],
  );
});

test('tuiStateReducer stores notice and studio progress events as system timeline messages', () => {
  let state = startRun(initialState(), 'req-1');

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'system.notice',
      requestId: 'req-1',
      message: '授权已更新',
    },
    now: 1100,
    message: {
      id: 'message:notice-1',
      role: 'system',
      text: '授权已更新',
      requestId: 'req-1',
      createdAt: new Date(1100).toISOString(),
    },
  });

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'studio.progress',
      requestId: 'req-1',
      event: {
        type: 'tasks_queued',
        taskCount: 2,
      },
    },
    now: 1200,
    message: {
      id: 'message:studio-progress-1',
      role: 'system',
      text: '[studio] tasks queued：2 项',
      requestId: 'req-1',
      createdAt: new Date(1200).toISOString(),
    },
  });

  assert.deepEqual(timelineMessagesByRole(state, 'system').slice(-2), [
    {
      id: 'message:notice-1',
      type: 'message',
      role: 'system',
      text: '授权已更新',
      status: 'completed',
      requestId: 'req-1',
      createdAt: new Date(1100).toISOString(),
    },
    {
      id: 'message:studio-progress-1',
      type: 'message',
      role: 'system',
      text: '[studio] tasks queued：2 项',
      status: 'completed',
      requestId: 'req-1',
      createdAt: new Date(1200).toISOString(),
    },
  ]);
  assert.deepEqual(selectFocusedTimeline(state).map((entry) => entry.id), [
    'message:req-1:user',
    'message:notice-1',
    'message:studio-progress-1',
  ]);
  assert.deepEqual(transcriptTimeline(state), [['user', 'hello']]);
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
  });

  const session = state.sessions['chat:pet']!;
  assert.equal(session.activeRun, null);
  assert.deepEqual(session.tokenUsage, usage);
  assert.deepEqual(session.sessionTokenUsage, {
    ...usage,
    scope: 'session',
  });
});

test('tuiStateReducer clears session token usage when clearing session state', () => {
  let state = initialState();
  state = {
    ...state,
    ui: {
      composerTarget: 'studio',
      studioConversationId: 'conversation-1',
      externalEditorOpen: true,
    },
    sessions: {
      ...state.sessions,
      'chat:pet': {
        ...state.sessions['chat:pet']!,
        kind: 'studio',
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
        sessionTokenUsage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          scope: 'session',
        },
      },
    },
  };

  state = tuiStateReducer(state, {
    type: 'session.clear',
  });

  assert.equal(state.sessions['chat:pet']?.tokenUsage, undefined);
  assert.equal(state.sessions['chat:pet']?.sessionTokenUsage, undefined);
  assert.equal(state.sessions['chat:pet']?.kind, 'chat');
  assert.deepEqual(state.ui, {
    composerTarget: 'chat',
    studioConversationId: null,
    externalEditorOpen: false,
  });
});

test('tuiStateReducer materializes timeline state from a checkpoint snapshot', () => {
  let state = initialState('chat:pet');
  state = {
    ...state,
    sessions: {
      ...state.sessions,
      'chat:other': {
        ...createSession({ id: 'chat:other' }),
        activeRun: {
          requestId: 'other-req',
          state: 'running',
          activity: 'thinking',
          startedAt: 1,
        },
      },
      'chat:pet': {
        ...state.sessions['chat:pet']!,
        activeRun: {
          requestId: 'old-req',
          state: 'running',
          activity: 'thinking',
          startedAt: 1,
        },
        runtime: { model: 'old-model', cwd: '/old' },
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
        sessionTokenUsage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          scope: 'session',
        },
      },
    },
  };

  state = tuiStateReducer(state, {
    type: 'session.snapshot.loaded',
    reason: 'startup',
    snapshot: sessionSnapshot({
      sessionId: 'chat:pet',
      kind: 'chat',
      timeline: [
        {
          id: 'message:user-1',
          type: 'message',
          role: 'user',
          text: 'hello',
          status: 'completed',
          requestId: 'req-1',
        },
        {
          id: 'message:assistant-1',
          type: 'message',
          role: 'assistant',
          text: 'hi',
          status: 'completed',
          requestId: 'req-1',
        },
      ],
      activeRun: {
        requestId: 'req-1',
        state: 'running',
        activity: 'streaming',
        startedAt: 1000,
      },
      runtime: {
        model: 'new-model',
        contextWindow: 1000,
      },
      tokenUsage: {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
      },
    }),
  });

  const session = state.sessions['chat:pet']!;
  assert.equal(state.focusedSessionId, 'chat:pet');
  assert.deepEqual(transcriptTimeline(state), [
    ['user', 'hello'],
    ['assistant', 'hi'],
  ]);
  assert.deepEqual(session.timeline.map((entry) => [entry.id, entry.type]), [
    ['message:user-1', 'message'],
    ['message:assistant-1', 'message'],
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
  assert.equal(activeRunActivity(activeRun(state, 'req-1')), 'streaming');
  assert.equal(activeRun(state, 'old-req'), undefined);
  assert.equal(state.sessions['chat:other']?.activeRun?.requestId, 'other-req');
});

test('tuiStateReducer normalizes active run startedAt when applying a snapshot', () => {
  const now = 1_719_999_999_000;
  const state = tuiStateReducer(initialState('chat:pet'), {
    type: 'session.snapshot.loaded',
    reason: 'completion',
    now,
    snapshot: sessionSnapshot({
      sessionId: 'chat:pet',
      kind: 'chat',
      timeline: [],
      activeRun: {
        requestId: 'req-1',
        state: 'running',
        activity: 'streaming',
        startedAt: 1_719_999_939,
      },
    }),
  });

  assert.equal(selectFocusedActiveRun(state)?.startedAt, 1_719_999_939_000);
});

test('tuiStateReducer applies completed output before reconnect without a terminal active run', () => {
  const state = tuiStateReducer(initialState('chat:pet'), {
    type: 'session.snapshot.loaded',
    reason: 'reconnect',
    snapshot: sessionSnapshot({
      sessionId: 'chat:pet',
      kind: 'chat',
      timeline: [
        {
          id: 'message:user-1',
          type: 'message',
          role: 'user',
          text: 'hello',
          status: 'completed',
          requestId: 'req-done',
        },
        {
          id: 'message:assistant-1',
          type: 'message',
          role: 'assistant',
          text: 'done',
          status: 'completed',
          requestId: 'req-done',
        },
      ],
      activeRun: null,
    }),
  });

  assert.equal((state.sessions['chat:pet']?.activeRun?.requestId ?? null), null);
  assert.equal(activeRun(state, 'req-done'), undefined);
  assert.equal(selectFocusedActiveRun(state), null);
  assert.deepEqual(transcriptTimeline(state), [
    ['user', 'hello'],
    ['assistant', 'done'],
  ]);
  assert.deepEqual(state.sessions['chat:pet']?.timeline.map((entry) => entry.id), [
    'message:user-1',
    'message:assistant-1',
  ]);
});

test('tuiStateReducer resumes a session from snapshot while clearing previous run state', () => {
  let state = startRun(initialState('chat:old'), 'old-req');
  state = {
    ...state,
    ui: {
      composerTarget: 'studio',
      studioConversationId: 'conversation-1',
      externalEditorOpen: true,
    },
  };

  state = tuiStateReducer(state, {
    type: 'session.snapshot.loaded',
    reason: 'resume',
    snapshot: sessionSnapshot({
      sessionId: 'chat:new',
      kind: 'studio',
      timeline: [
        {
          id: 'message:user-new',
          type: 'message',
          role: 'user',
          text: 'resumed',
          status: 'completed',
        },
      ],
      activeRun: null,
    }),
  });

  assert.equal(state.focusedSessionId, 'chat:new');
  assert.equal(activeRun(state, 'old-req'), undefined);
  assert.equal((state.sessions['chat:old']?.activeRun?.requestId ?? null), null);
  assert.deepEqual(state.ui, {
    composerTarget: 'chat',
    studioConversationId: null,
    externalEditorOpen: false,
  });
  assert.equal(state.sessions['chat:new']?.kind, 'studio');
  assert.deepEqual(transcriptTimeline(state, 'chat:new'), [
    ['user', 'resumed'],
  ]);
  assert.deepEqual(state.sessions['chat:new']?.timeline.map((entry) => entry.id), [
    'message:user-new',
  ]);
});

test('tuiStateReducer preserves reconnect token usage when snapshot omits usage', () => {
  let state = initialState('chat:pet');
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
        sessionTokenUsage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          scope: 'session',
        },
      },
    },
  };

  state = tuiStateReducer(state, {
    type: 'session.snapshot.loaded',
    reason: 'reconnect',
    snapshot: sessionSnapshot({
      sessionId: 'chat:pet',
      kind: 'chat',
      timeline: [],
      activeRun: null,
    }),
  });

  assert.deepEqual(state.sessions['chat:pet']?.tokenUsage, {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  });
  assert.equal(state.sessions['chat:pet']?.sessionTokenUsage?.totalTokens, 15);

  state = tuiStateReducer(state, {
    type: 'session.snapshot.loaded',
    reason: 'startup',
    snapshot: sessionSnapshot({
      sessionId: 'chat:pet',
      kind: 'chat',
      timeline: [],
      activeRun: null,
    }),
  });

  assert.equal(state.sessions['chat:pet']?.tokenUsage, undefined);
  assert.equal(state.sessions['chat:pet']?.sessionTokenUsage, undefined);
});

test('tuiStateReducer preserves observed token usage on completion snapshot', () => {
  let state = initialState('chat:pet');
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
    type: 'session.snapshot.loaded',
    reason: 'completion',
    snapshot: sessionSnapshot({
      sessionId: 'chat:pet',
      kind: 'chat',
      timeline: [],
      activeRun: null,
    }),
  });

  assert.deepEqual(state.sessions['chat:pet']?.tokenUsage, {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  });
});

test('tuiStateReducer replaces live-only operation and subagent entries on completion', () => {
  let state = initialState('chat:pet');
  state = {
    ...state,
    sessions: {
      ...state.sessions,
      'chat:pet': {
        ...state.sessions['chat:pet']!,
        timeline: [
          {
            id: 'operation:live-tool',
            type: 'operation',
            requestId: 'req-1',
            operationKey: 'live-tool',
            kind: 'shell',
            title: 'Run command',
            phase: 'completed',
          },
          {
            id: 'message:live-subagent',
            type: 'message',
            role: 'subagent',
            requestId: 'req-1',
            text: 'live subagent detail',
            status: 'completed',
          },
        ],
      },
    },
  };

  state = tuiStateReducer(state, {
    type: 'session.snapshot.loaded',
    reason: 'completion',
    snapshot: sessionSnapshot({
      sessionId: 'chat:pet',
      kind: 'chat',
      timeline: [{
        id: 'message:user-1',
        type: 'message',
        role: 'user',
        text: 'hello',
        status: 'completed',
      }],
      activeRun: null,
    }),
  });

  assert.deepEqual(state.sessions['chat:pet']?.timeline.map((entry) => entry.id), ['message:user-1']);
});

test('tuiStateReducer restores checkpoint-owned pending approval from a snapshot', () => {
  let state = initialState('chat:pet');

  state = tuiStateReducer(state, {
    type: 'session.snapshot.loaded',
    reason: 'reconnect',
    snapshot: sessionSnapshot({
      sessionId: 'chat:pet',
      kind: 'chat',
      timeline: [
        {
          id: 'message:user-1',
          type: 'message',
          role: 'user',
          text: 'needs approval',
          status: 'completed',
          requestId: 'req-review',
        },
      ],
      activeRun: {
        requestId: 'req-review',
        state: 'waiting_review',
        startedAt: 1000,
        reviewAction: {
          actionId: 'interrupt-1',
          petId: 'pet-a',
          reviews: [{
            id: 'review-1',
            schemaVersion: 1,
            view: { kind: 'plain', body: 'Approve?' },
            options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
          }],
        },
      },
    }),
  });

  const pending = selectFocusedPendingApproval(state);
  assert.equal((state.sessions['chat:pet']?.activeRun?.requestId ?? null), 'req-review');
  assert.equal(activeReviewAction(activeRun(state, 'req-review'))?.reviews[0]?.id, 'review-1');
  assert.equal(pending?.requestId, 'req-review');
  assert.equal(pending?.review.id, 'review-1');
  assert.equal(pending?.petId, 'pet-a');
});

test('tuiStateReducer clears only the active run owned by the cleared session', () => {
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

  assert.equal(activeRun(state, 'req-main'), undefined);
  assert.equal(state.sessions['chat:other']?.activeRun?.requestId, 'req-other');
  assert.equal(state.sessions['chat:pet']?.timeline.length, 0);
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

test('tuiStateReducer ignores late terminal events after local interrupt release', () => {
  let state = startRun(initialState(), 'req-1');
  state = tuiStateReducer(state, {
    type: 'run.finish',
    requestId: 'req-1',
    statusNotice: '已请求打断',
    messages: [{
      id: 'message:req-1:interrupt-local-release',
      role: 'system',
      text: '打断请求已发送，本地先释放输入；迟到的旧响应会被忽略。',
    }],
  });

  const next = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'message.completed',
      requestId: 'req-1',
      role: 'assistant',
      text: 'late final answer',
    },
    now: 1200,
  });

  assert.equal(next, state);
  assert.equal(selectFocusedActiveRun(next), null);
  assert.equal(timelineMessageText(next, 'chat:pet', 'req-1:assistant:0'), undefined);
  assert.deepEqual(transcriptTimeline(next), [['user', 'hello']]);
  assert.deepEqual(timelineMessagesByRole(next, 'system').map((notice) => notice.text), [
    '打断请求已发送，本地先释放输入；迟到的旧响应会被忽略。',
  ]);
});

test('tuiStateReducer ignores late terminal events after interrupt release and snapshot replacement', () => {
  let state = startRun(initialState(), 'req-1');
  state = tuiStateReducer(state, {
    type: 'run.finish',
    requestId: 'req-1',
    statusNotice: '已请求打断',
    messages: [{
      id: 'message:req-1:interrupt-local-release',
      role: 'system',
      text: '打断请求已发送，本地先释放输入；迟到的旧响应会被忽略。',
    }],
  });
  state = tuiStateReducer(state, {
    type: 'session.snapshot.loaded',
    reason: 'reconnect',
    snapshot: sessionSnapshot({
      sessionId: 'chat:pet',
      kind: 'chat',
      timeline: [{
        id: 'message:0:user',
        type: 'message',
        role: 'user',
        text: 'hello',
        status: 'completed',
      }],
      activeRun: null,
    }),
  });

  const next = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'message.completed',
      requestId: 'req-1',
      role: 'assistant',
      text: 'late final answer',
    },
    now: 1300,
  });

  assert.equal(next, state);
  assert.equal(selectFocusedActiveRun(next), null);
  assert.equal(selectFocusedTimeline(next).some((entry) =>
    entry.type === 'message' && entry.role === 'assistant'), false);
  assert.deepEqual(transcriptTimeline(next), [['user', 'hello']]);
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

test('tuiStateReducer tracks operation lifecycle in timeline without terminal message rows', () => {
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
  assert.equal(activeRunActivity(activeRun), 'using_tool');
  assert.deepEqual(
    selectFocusedTimeline(state).filter((entry) => entry.requestId === 'req-1').map((entry) => entry.id),
    ['message:req-1:user', 'req-1:operation:tool-1'],
  );
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
  });

  activeRun = selectFocusedActiveRun(state);
  assert.deepEqual(selectFocusedActiveOperations(state), []);
  assert.deepEqual(transcriptTimeline(state), [
    ['user', 'hello'],
  ]);
  assert.equal(selectFocusedTimeline(state).filter((entry) => entry.id === 'req-1:operation:tool-1').length, 1);
  const completedTimelineEntry = selectFocusedTimeline(state).find((entry) => entry.id === 'req-1:operation:tool-1');
  assert.equal(completedTimelineEntry?.type === 'operation' ? completedTimelineEntry.phase : undefined, 'completed');
  assert.equal(completedTimelineEntry?.type === 'operation' ? completedTimelineEntry.summary : undefined, 'ok');
  assert.equal(selectFocusedTimeline(state).some((entry) => entry.id === 'message:op-complete'), false);
});

test('tuiStateReducer keeps final assistant output after operations', () => {
  let state = startRun(initialState(), 'req-1');

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'message.delta',
      requestId: 'req-1',
      role: 'assistant',
      text: '我先看一下文件。',
    },
    now: 1100,
  });
  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'operation',
      requestId: 'req-1',
      phase: 'started',
      operation: {
        id: 'tool-1',
        kind: 'shell',
        title: 'Shell',
        target: 'python3 sort_demo.py --dataset random',
      },
    },
    now: 1200,
  });
  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'operation',
      requestId: 'req-1',
      phase: 'completed',
      operation: {
        id: 'tool-1',
        kind: 'shell',
        title: 'Shell',
        target: 'python3 sort_demo.py --dataset random',
        summary: '完成',
      },
    },
    now: 1300,
  });
  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'message.completed',
      requestId: 'req-1',
      role: 'assistant',
      text: '文件检查完了，这是结果。',
    },
    now: 1400,
  });

  assert.deepEqual(selectFocusedTimeline(state).map((entry) => entry.id), [
    'message:req-1:user',
    'req-1:assistant:0',
    'req-1:operation:tool-1',
    'req-1:assistant:1',
  ]);
  assert.deepEqual(selectFocusedTimeline(state).map((entry) => (
    entry.type === 'message'
      ? [entry.type, entry.role, entry.status, entry.createdAt, entry.updatedAt, entry.text]
      : [entry.type, entry.phase, entry.summary]
  )), [
    ['message', 'user', 'completed', new Date(1000).toISOString(), undefined, 'hello'],
    ['message', 'assistant', 'completed', new Date(1100).toISOString(), undefined, '我先看一下文件。'],
    ['operation', 'completed', '完成'],
    ['message', 'assistant', 'completed', new Date(1400).toISOString(), undefined, '文件检查完了，这是结果。'],
  ]);
});

test('tuiStateReducer keeps operation display fields when completed event is sparse', () => {
  let state = startRun(initialState(), 'req-1');
  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'operation',
      requestId: 'req-1',
      phase: 'started',
      operation: {
        id: 'tool-1',
        kind: 'shell',
        title: 'Shell',
        target: 'npm test',
        summary: '执行测试',
        details: { cwd: '/repo' },
      },
    },
    now: 1200,
  });
  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'operation',
      requestId: 'req-1',
      phase: 'completed',
      operation: {
        id: 'tool-1',
        kind: 'shell',
      },
    },
    now: 1400,
  });

  const completedTimelineEntry = selectFocusedTimeline(state).find((entry) => entry.id === 'req-1:operation:tool-1');
  assert.equal(completedTimelineEntry?.type === 'operation' ? completedTimelineEntry.phase : undefined, 'completed');
  assert.equal(completedTimelineEntry?.type === 'operation' ? completedTimelineEntry.title : undefined, 'Shell');
  assert.equal(completedTimelineEntry?.type === 'operation' ? completedTimelineEntry.target : undefined, 'npm test');
  assert.equal(completedTimelineEntry?.type === 'operation' ? completedTimelineEntry.summary : undefined, '执行测试');
  assert.deepEqual(completedTimelineEntry?.type === 'operation' ? completedTimelineEntry.details : undefined, { cwd: '/repo' });
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
  assert.equal(selectFocusedActiveRun(state)?.state, 'waiting_review');
  assert.deepEqual(selectFocusedPendingApproval(state), {
    requestId: 'req-1',
    actionId: 'request:req-1:reviews:review-1',
    review: {
      id: 'review-1',
      schemaVersion: 1,
      view: { kind: 'plain', body: 'Approve?' },
      options: [],
    },
    reviews: [{
      id: 'review-1',
      schemaVersion: 1,
      view: { kind: 'plain', body: 'Approve?' },
      options: [],
    }],
    decisions: [],
    petId: 'pet-a',
  });
  assert.equal(state.statusNotice, null);
  assert.equal(selectFocusedTimeline(state).some((entry) => entry.id === 'req-1:review:review-1'), false);

  const activeRunBefore = selectFocusedActiveRun(state);
  state = tuiStateReducer(state, {
    type: 'review.resolution.sent',
    requestId: 'req-1',
    actionId: 'request:req-1:reviews:review-1',
    decision: { reviewId: 'review-1', selectedOptionId: 'approve' },
  });

  assert.equal(selectFocusedBusy(state), true);
  assert.equal(selectFocusedActiveRun(state)?.state, 'waiting_review');
  assert.equal(activeReviewAction(selectFocusedActiveRun(state))?.actionId, 'request:req-1:reviews:review-1');
  assert.equal(state.reviewDrafts['request:req-1:reviews:review-1']?.resolutionSent, true);
  // The client-local resolution preserves the shared run until the server
  // observes resumed activity.
  assert.equal(selectFocusedActiveRun(state)?.requestId, 'req-1');
  assert.equal(selectFocusedActiveRun(state)?.startedAt, activeRunBefore?.startedAt);
  assert.equal(selectFocusedPendingApproval(state), null);
  assert.equal(selectFocusedTimeline(state).some((entry) => entry.id === 'message:review-response'), false);

  state = tuiStateReducer(state, {
    type: 'run.interrupting',
    requestId: 'req-1',
  });

  assert.equal(selectFocusedActiveRun(state)?.state, 'interrupting');
  assert.equal(state.statusNotice, null);
});

test('tuiStateReducer keeps batch draft local and out of the conversation timeline', () => {
  let state = startRun(initialState(), 'req-1');
  const reviews = ['review-1', 'review-2'].map((id) => ({
    id,
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: id },
    options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' as const } }],
  }));
  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'human_review.requested',
      requestId: 'req-1',
      interruptId: 'interrupt-1',
      review: reviews[0]!,
      reviews,
    },
    now: 1200,
  });
  const timelineBefore = selectFocusedTimeline(state);

  const stateAfterStaleDecision = tuiStateReducer(state, {
    type: 'review.draft.record',
    requestId: 'req-1',
    actionId: 'interrupt-stale',
    decision: { reviewId: 'review-1', selectedOptionId: 'approve' },
  });
  assert.equal(stateAfterStaleDecision, state);

  state = tuiStateReducer(state, {
    type: 'review.draft.record',
    requestId: 'req-1',
    actionId: 'interrupt-1',
    decision: { reviewId: 'review-1', selectedOptionId: 'approve' },
  });

  assert.equal(selectFocusedPendingApproval(state)?.review.id, 'review-2');
  assert.deepEqual(state.reviewDrafts['interrupt-1']?.decisions, [
    { reviewId: 'review-1', selectedOptionId: 'approve' },
  ]);
  assert.deepEqual(selectFocusedTimeline(state), timelineBefore);

  state = tuiStateReducer(state, {
    type: 'session.snapshot.loaded',
    reason: 'reconnect',
    snapshot: sessionSnapshot({
      sessionId: 'chat:pet',
      kind: 'chat',
      timeline: [],
      activeRun: {
        requestId: 'req-1',
        state: 'waiting_review',
        reviewAction: {
          actionId: 'interrupt-1',
          reviews,
        },
      },
    }),
  });

  assert.deepEqual(state.reviewDrafts['interrupt-1']?.decisions, []);
  assert.equal(selectFocusedPendingApproval(state)?.review.id, 'review-1');
});

test('tuiStateReducer keeps a sent review resolution local until the server responds', () => {
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
    type: 'review.resolution.sent',
    requestId: 'req-1',
    actionId: 'request:req-1:reviews:review-1',
  });

  assert.equal(selectFocusedActiveRun(state)?.state, 'waiting_review');
  assert.equal(activeReviewAction(selectFocusedActiveRun(state))?.actionId, 'request:req-1:reviews:review-1');
  assert.equal(state.reviewDrafts['request:req-1:reviews:review-1']?.resolutionSent, true);
  assert.equal(selectFocusedBusy(state), true);
  assert.equal(selectFocusedPendingApproval(state), null);

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
    now: 1300,
  });

  assert.equal(state.reviewDrafts['request:req-1:reviews:review-1']?.resolutionSent, undefined);
  assert.equal(selectFocusedBusy(state), false);
  assert.equal(selectFocusedPendingApproval(state)?.review.id, 'review-1');
});

test('tuiStateReducer sent review resolution preserves the owning run', () => {
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

  state = tuiStateReducer(state, {
    type: 'review.resolution.sent',
    requestId: 'req-1',
    actionId: 'request:req-1:reviews:review-1',
    decision: { reviewId: 'review-1', selectedOptionId: 'approve' },
  });

  assert.equal(state.sessions['chat:pet']?.activeRun?.requestId, 'req-1');
  assert.equal(selectFocusedPendingApproval(state), null);
  assert.equal(selectFocusedActiveRun(state)?.state, 'waiting_review');
  assert.equal(state.reviewDrafts['request:req-1:reviews:review-1']?.resolutionSent, true);

  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'operation',
      requestId: 'req-1',
      phase: 'completed',
      operation: { id: 'tool-1', kind: 'shell' },
    },
    now: 1300,
  });

  assert.equal(activeRunActivity(selectFocusedActiveRun(state)), 'thinking');
  assert.equal(activeReviewAction(selectFocusedActiveRun(state)), null);
  assert.equal(state.reviewDrafts['request:req-1:reviews:review-1'], undefined);
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
    actionId: 'request:req-1:reviews:review-1',
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
    reviews: [{
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
    }],
    decisions: [],
  });
});

test('tuiStateReducer finishes error and terminal messages', () => {
  let state = startRun(initialState(), 'chat-req');
  state = tuiStateReducer(state, {
    type: 'event.received',
    event: {
      type: 'error',
      requestId: 'chat-req',
      message: 'boom',
    },
    now: 1200,
    message: {
      role: 'system',
      text: '出错：boom',
      requestId: 'chat-req',
      createdAt: new Date(1200).toISOString(),
    },
  });

  assert.equal(selectFocusedActiveRun(state), null);
  assert.equal(state.statusNotice, '出错，已恢复输入');
  assert.equal(timelineMessagesByRole(state, 'system').at(-1)?.text, '出错：boom');

  state = startRun(state, 'studio-req');
  state = tuiStateReducer(state, {
    type: 'run.finish',
    requestId: 'studio-req',
    messages: [{
      role: 'system',
      text: '[studio] turn stopped (无最终输出)',
      requestId: 'studio-req',
    }, {
      role: 'system',
      text: '[studio] stopped: done enough',
      requestId: 'studio-req',
    }],
  });

  assert.equal(selectFocusedActiveRun(state), null);
  assert.deepEqual(timelineMessagesByRole(state, 'system').slice(-2).map((item) => item.text), [
    '[studio] turn stopped (无最终输出)',
    '[studio] stopped: done enough',
  ]);

  state = startRun(state, 'studio-error');
  state = tuiStateReducer(state, {
    type: 'run.finish',
    requestId: 'studio-error',
    messages: [{
      role: 'system',
      text: '[studio 出错] planner failed',
      requestId: 'studio-error',
    }],
    statusNotice: 'Studio 出错，已恢复输入',
  });

  assert.equal(selectFocusedActiveRun(state), null);
  assert.equal(state.statusNotice, 'Studio 出错，已恢复输入');
  assert.equal(timelineMessagesByRole(state, 'system').at(-1)?.text, '[studio 出错] planner failed');
});
