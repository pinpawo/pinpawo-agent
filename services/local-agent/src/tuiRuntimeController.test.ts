import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { TuiRuntimeController } from './tui/TuiRuntimeController';
import { TUI_CORE_TARGET_ACTIONS } from './tui/contracts/tuiCoreContract';
import { createComposerHistoryState } from './tui/input/composerHistory';
import type { TuiAction, TuiState } from './tui/state/tuiState';

function pendingReviewState(): TuiState {
  const review = {
    id: 'review-1',
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: 'Need review' },
    options: [],
  };
  return {
    connection: { status: 'ready', message: 'ready' },
    focusedSessionId: 'sess-1',
    ui: {
      mode: 'chat',
      studioConversationId: null,
      externalEditorOpen: false,
    },
    runs: {
      'req-1': {
        requestId: 'req-1',
        sessionId: 'sess-1',
        kind: 'chat',
        phase: 'waiting_human',
        timelineEntryIds: [],
        pendingReview: {
          requestId: 'req-1',
          review,
          reviews: [review],
          reviewIndex: 0,
          decisions: [],
        },
        startedAt: 1,
        charCount: 0,
      },
    },
    input: { text: '', cursorOffset: 0, focused: true, history: createComposerHistoryState() },
    sessions: {
      'sess-1': {
        id: 'sess-1',
        kind: 'chat',
        actor: { label: 'Pet', summary: 'summary' },
        runtime: {},
        timeline: [],
        notices: [],
        activities: [],
        tokenUsage: null,
        activeRunId: 'req-1',
      },
    },
  };
}

function pendingReviewActionState(reviewIndex = 0): TuiState {
  const state = pendingReviewState();
  const reviews = [
    {
      id: 'review-1',
      schemaVersion: 1,
      view: { kind: 'plain' as const, body: 'First review' },
      options: [],
    },
    {
      id: 'review-2',
      schemaVersion: 1,
      view: { kind: 'plain' as const, body: 'Second review' },
      options: [],
    },
  ];
  state.runs['req-1']!.pendingReview = {
    requestId: 'req-1',
    review: reviews[reviewIndex]!,
    reviews,
    reviewIndex,
    decisions: reviewIndex > 0
      ? [{ reviewId: 'review-1', selectedOptionId: 'approve' }]
      : [],
  };
  return state;
}

function busyRunState(): TuiState {
  return {
    ...pendingReviewState(),
    runs: {
      'req-1': {
        requestId: 'req-1',
        sessionId: 'sess-1',
        kind: 'chat',
        phase: 'thinking',
        timelineEntryIds: [],
        startedAt: 1,
        charCount: 0,
      },
    },
  };
}

function createController(state: TuiState) {
  const actions: TuiAction[] = [];
  const sent: unknown[] = [];
  let resetCount = 0;
  const controller = new TuiRuntimeController({
    actorId: 'pet-1',
    localServerPort: 0,
    dispatch: (action) => actions.push(action),
    getState: () => state,
    resetTimelineView: () => {
      resetCount += 1;
    },
    setNow: () => {},
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (controller as any).wsClient = {
    isConnected: () => true,
    send: (message: unknown) => sent.push(message),
    disconnect: () => {},
  };
  return { controller, actions, sent, get resetCount() { return resetCount; } };
}

test('TuiRuntimeController uses configured workdir when runtime payload omits cwd', () => {
  const actions: TuiAction[] = [];
  const controller = new TuiRuntimeController({
    actorId: 'pet-1',
    localServerPort: 0,
    workdir: '/tmp/pinpawo-tui-workdir',
    dispatch: (action) => actions.push(action),
    getState: () => pendingReviewState(),
    resetTimelineView: () => {},
    setNow: () => {},
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (controller as any).setRuntimeFromHealth({
    model: 'test-model',
    workspaceId: 'workspace-test',
    workspaceName: 'Workspace Test',
    workspaceRoot: '/tmp/pinpawo-tui-workdir',
  });

  assert.deepEqual(actions, [{
    type: 'session.set_runtime',
    runtime: {
      model: 'test-model',
      cwd: '/tmp/pinpawo-tui-workdir',
      workspaceId: 'workspace-test',
      workspaceName: 'Workspace Test',
      workspaceRoot: '/tmp/pinpawo-tui-workdir',
    },
  }]);
});

test('TuiRuntimeController submits canonical review responses without legacy resume extras', () => {
  const { controller, actions, sent } = createController(pendingReviewState());

  const submitted = controller.submitReviewResponse({
    id: 'respond',
    label: 'Respond',
    input: { kind: 'text', key: 'message', required: true, multiline: true },
    decision: { type: 'respond', messageInputKey: 'message' },
  }, '请先解释风险');

  assert.equal(submitted, true);
  assert.deepEqual(sent, [{
    type: 'human_review_response',
    requestId: 'req-1',
    reviewId: 'review-1',
    selectedOptionId: 'respond',
    input: { message: '请先解释风险' },
    decisions: [
      {
        reviewId: 'review-1',
        selectedOptionId: 'respond',
        input: { message: '请先解释风险' },
      },
    ],
  }]);
  assert.equal(actions.some((action) => action.type === 'review.response.resume'), true);
});

test('TuiRuntimeController queues review action decisions until the final approval', () => {
  const first = createController(pendingReviewActionState());

  const firstSubmitted = first.controller.submitReviewResponse({
    id: 'approve',
    label: 'Approve',
    decision: { type: 'approve' },
  });

  assert.equal(firstSubmitted, true);
  assert.deepEqual(first.sent, []);
  const advance = first.actions.find((action) => action.type === 'review.action.advance');
  assert.equal(advance?.type, 'review.action.advance');
  if (advance?.type === 'review.action.advance') {
    assert.equal(advance.requestId, 'req-1');
    assert.deepEqual(advance.decision, { reviewId: 'review-1', selectedOptionId: 'approve' });
    assert.equal(advance.message, 'Approve');
    assert.equal(advance.statusMessage, '等待你的决定');
  }

  const final = createController(pendingReviewActionState(1));
  const finalSubmitted = final.controller.submitReviewResponse({
    id: 'approve',
    label: 'Approve',
    decision: { type: 'approve' },
  });

  assert.equal(finalSubmitted, true);
  assert.deepEqual(final.sent, [{
    type: 'human_review_response',
    requestId: 'req-1',
    reviewId: 'review-2',
    selectedOptionId: 'approve',
    decisions: [
      { reviewId: 'review-1', selectedOptionId: 'approve' },
      { reviewId: 'review-2', selectedOptionId: 'approve' },
    ],
  }]);
  assert.equal(final.actions.some((action) => action.type === 'review.response.resume'), true);
});

test('TuiRuntimeController sends a review action response when the first review is rejected', () => {
  const { controller, actions, sent } = createController(pendingReviewActionState());

  const submitted = controller.submitReviewResponse({
    id: 'reject',
    label: 'Reject',
    decision: { type: 'reject' },
  });

  assert.equal(submitted, true);
  assert.deepEqual(sent, [{
    type: 'human_review_response',
    requestId: 'req-1',
    reviewId: 'review-1',
    selectedOptionId: 'reject',
    decisions: [
      { reviewId: 'review-1', selectedOptionId: 'reject' },
    ],
  }]);
  assert.equal(actions.some((action) => action.type === 'review.response.resume'), true);
  assert.equal(actions.some((action) => action.type === 'review.action.advance'), false);
});

test('TuiRuntimeController blocks empty required review input', () => {
  const { controller, actions, sent } = createController(pendingReviewState());

  const submitted = controller.submitReviewResponse({
    id: 'respond',
    label: 'Respond',
    input: { kind: 'text', key: 'message', required: true },
    decision: { type: 'respond', messageInputKey: 'message' },
  });

  assert.equal(submitted, false);
  assert.deepEqual(sent, []);
  assert.equal(actions.some((action) => action.type === 'message.append'), true);
});

test('TuiRuntimeController interrupts pending human review instead of dismissing it locally', () => {
  const { controller, actions, sent } = createController(pendingReviewState());

  const submitted = controller.requestInterrupt();

  assert.equal(submitted, true);
  assert.deepEqual(sent, [{
    type: 'interrupt_request',
    requestId: 'req-1',
  }]);
  assert.deepEqual(actions.find((action) => action.type === 'run.interrupting'), {
    type: 'run.interrupting',
    requestId: 'req-1',
    statusMessage: '正在打断',
  });
});

test('TuiRuntimeController releases input locally after interrupt timeout', () => {
  mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  try {
    const { controller, actions } = createController(busyRunState());

    const submitted = controller.requestInterrupt();
    mock.timers.tick(1800);

    assert.equal(submitted, true);
    const finish = actions.find((action) => action.type === 'run.finish');
    assert.equal(finish?.type, 'run.finish');
    if (finish?.type !== 'run.finish') return;
    assert.equal(finish.requestId, 'req-1');
    assert.equal(finish.statusMessage, '已请求打断');
    assert.deepEqual(
      finish.messages?.map((message) => [message.kind, message.text]),
      [['system', '打断请求已发送，本地先释放输入；迟到的旧响应会被忽略。']],
    );
  } finally {
    mock.timers.reset();
  }
});

test('TuiRuntimeController resets static timeline view for new sessions', () => {
  const harness = createController(pendingReviewState());

  harness.controller.startNewSession();

  assert.equal(harness.resetCount, 1);
  assert.deepEqual(harness.actions.slice(0, 2), [
    { type: 'input.set', value: '' },
    { type: 'session.clear', statusMessage: '已创建新会话' },
  ]);
  assert.deepEqual(harness.sent, [{ type: 'new_session' }]);
});

test('TuiRuntimeController restores a reconnect snapshot before opening websocket', async () => {
  const state = pendingReviewState();
  const harness = createController(state);
  const events: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (harness.controller as any).localServerClient = {
    isHealthy: async () => true,
    readSessionSnapshot: async () => {
      events.push('snapshot');
      return {
        sessionId: 'sess-1',
        kind: 'chat',
        timeline: [{
          id: 'message:user-1',
          type: 'message',
          role: 'user',
          text: 'hello',
          status: 'completed',
          source: 'checkpoint',
        }],
        runs: [],
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (harness.controller as any).wsClient = {
    hasSocket: () => false,
    isConnected: () => false,
    connect: () => {
      events.push('connect');
    },
    send: (message: unknown) => harness.sent.push(message),
    disconnect: () => {},
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (harness.controller as any).reconnect();

  assert.deepEqual(events, ['snapshot', 'connect']);
  assert.equal(harness.resetCount, 1);
  assert.equal(harness.actions[0]?.type, TUI_CORE_TARGET_ACTIONS.sessionSnapshotLoaded);
  assert.equal(
    harness.actions[0]?.type === TUI_CORE_TARGET_ACTIONS.sessionSnapshotLoaded
      ? harness.actions[0].source
      : undefined,
    'reconnect',
  );
});

test('TuiRuntimeController reconciles snapshots after stale review errors', async () => {
  const harness = createController(pendingReviewState());
  const events: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (harness.controller as any).localServerClient = {
    readSessionSnapshot: async () => {
      events.push('snapshot');
      return {
        sessionId: 'sess-1',
        kind: 'chat',
        timeline: [{
          id: 'message:user-1',
          type: 'message',
          role: 'user',
          text: 'hello',
          status: 'completed',
          source: 'checkpoint',
        }],
        runs: [],
      };
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (harness.controller as any).handleServerMessage({
    type: 'event',
    requestId: 'req-1',
    event: {
      type: 'error',
      requestId: 'req-1',
      message: '这个 review 已经过期，请等待当前确认面板刷新后再应答。',
      code: 'review_stale',
    },
  });

  await new Promise((resolve) => {
    setImmediate(resolve);
  });

  assert.deepEqual(events, ['snapshot']);
  assert.equal(harness.resetCount, 1);
  assert.equal(harness.actions[0]?.type, 'event.received');
  assert.equal(harness.actions[1]?.type, TUI_CORE_TARGET_ACTIONS.sessionSnapshotLoaded);
  assert.equal(
    harness.actions[1]?.type === TUI_CORE_TARGET_ACTIONS.sessionSnapshotLoaded
      ? harness.actions[1].source
      : undefined,
    'reconnect',
  );
});

test('TuiRuntimeController reconciles snapshots after completed messages', async () => {
  const harness = createController(pendingReviewState());
  const events: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (harness.controller as any).localServerClient = {
    readSessionSnapshot: async () => {
      events.push('snapshot');
      return {
        sessionId: 'sess-1',
        kind: 'chat',
        timeline: [{
          id: 'message:assistant-1',
          type: 'message',
          role: 'assistant',
          text: 'final',
          status: 'completed',
          source: 'checkpoint',
          requestId: 'req-1',
        }],
        runs: [],
      };
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (harness.controller as any).handleServerMessage({
    type: 'event',
    requestId: 'req-1',
    event: {
      type: 'message.completed',
      requestId: 'req-1',
      role: 'assistant',
      text: 'final',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    },
  });

  await new Promise((resolve) => {
    setImmediate(resolve);
  });

  assert.deepEqual(events, ['snapshot']);
  assert.equal(harness.resetCount, 1);
  assert.equal(harness.actions[0]?.type, 'event.received');
  assert.equal(harness.actions[1]?.type, TUI_CORE_TARGET_ACTIONS.sessionSnapshotLoaded);
  assert.equal(
    harness.actions[1]?.type === TUI_CORE_TARGET_ACTIONS.sessionSnapshotLoaded
      ? harness.actions[1].source
      : undefined,
    'reconcile',
  );
});
