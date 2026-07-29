import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { TuiRuntimeController } from './tui/TuiRuntimeController';
import type { LocalAgentClientMessage } from './localAgentProtocol';
import type {
  LocalAgentConnection,
  LocalAgentConnectionHandlers,
} from './tui/localAgentConnection';
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
    connection: { status: 'ready' },
    statusNotice: null,
    focusedSessionId: 'sess-1',
    reviewDrafts: {
      'interrupt-1': { actionId: 'interrupt-1', decisions: [] },
    },
    ui: {
      composerTarget: 'chat',
      studioConversationId: null,
      externalEditorOpen: false,
    },
    input: { text: '', cursorOffset: 0, focused: true, history: createComposerHistoryState() },
    sessions: {
      'sess-1': {
        sessionId: 'sess-1',
        kind: 'chat',
        actor: { label: 'Pet', summary: 'summary' },
        runtime: {},
        timeline: [],
        activeRun: {
          requestId: 'req-1',
          state: 'waiting_review',
          reviewAction: {
            actionId: 'interrupt-1',
            reviews: [review],
          },
          startedAt: 1,
        },
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
  const activeRun = state.sessions['sess-1']!.activeRun;
  if (activeRun?.state !== 'waiting_review') assert.fail('expected waiting review');
  activeRun.reviewAction = {
    actionId: 'interrupt-1',
    reviews,
  };
  state.reviewDrafts['interrupt-1'] = {
    actionId: 'interrupt-1',
    decisions: reviewIndex > 0
      ? [{ reviewId: 'review-1', selectedOptionId: 'approve' }]
      : [],
  };
  return state;
}

function busyRunState(): TuiState {
  const state = pendingReviewState();
  state.sessions['sess-1']!.activeRun = {
    requestId: 'req-1',
    state: 'running',
    activity: 'thinking',
    startedAt: 1,
  };
  return state;
}

function idleState(): TuiState {
  const state = pendingReviewState();
  state.sessions['sess-1']!.activeRun = null;
  state.reviewDrafts = {};
  return state;
}

function createController(
  state: TuiState,
  options: {
    connected?: boolean;
    sendResult?: boolean;
    onConnect?: () => void;
  } = {},
) {
  const actions: TuiAction[] = [];
  const sent: LocalAgentClientMessage[] = [];
  let resetCount = 0;
  let connected = options.connected ?? true;
  const connectionHandlerCalls: LocalAgentConnectionHandlers[] = [];
  const connection: LocalAgentConnection = {
    isConnected: () => connected,
    hasConnection: () => connected,
    connect: () => {
      connected = true;
      options.onConnect?.();
    },
    send: (message) => {
      if (options.sendResult === false) return false;
      sent.push(message);
      return true;
    },
    disconnect: () => {
      connected = false;
    },
  };
  const controller = new TuiRuntimeController({
    actorId: 'pet-1',
    localServerPort: 0,
    dispatch: (action) => actions.push(action),
    getState: () => state,
    resetTimelineView: () => {
      resetCount += 1;
    },
    setNow: () => {},
    connectionFactory: (handlers) => {
      connectionHandlerCalls.push(handlers);
      return connection;
    },
  });
  const connectionHandlers = connectionHandlerCalls[0];
  if (!connectionHandlers) assert.fail('expected connection handlers');
  return {
    controller,
    actions,
    sent,
    connection,
    connectionHandlers,
    get resetCount() { return resetCount; },
  };
}

test('TuiRuntimeController startup health check does not read runtime separately', async () => {
  const harness = createController(pendingReviewState());
  const calls: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (harness.controller as any).localServerClient = {
    isHealthy: async () => {
      calls.push('health');
      return true;
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connected = await (harness.controller as any).waitForLocalServer();

  assert.equal(connected, true);
  assert.deepEqual(calls, ['health']);
});

test('TuiRuntimeController routes injected connection lifecycle and messages', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const harness = createController(busyRunState());
  try {
    harness.connectionHandlers.onOpen();
    harness.connectionHandlers.onMessage({
      type: 'interrupting',
      requestId: 'req-1',
    });
    harness.connectionHandlers.onError(new Error('transport failed'));
    harness.connection.disconnect();
    harness.connectionHandlers.onClose();

    assert.deepEqual(harness.actions.find((action) => action.type === 'connection.set'), {
      type: 'connection.set',
      status: 'ready',
    });
    assert.equal(harness.sent[0]?.type, 'runtime_config.update');
    assert.equal(harness.actions.some((action) => action.type === 'run.interrupting'), true);
    assert.equal(harness.actions.some((action) => (
      action.type === 'message.appended'
      && action.message.text === '连接出错：transport failed'
    )), true);
    assert.equal(harness.actions.some((action) => (
      action.type === 'connection.set'
      && action.status === 'disconnected'
    )), true);
  } finally {
    harness.controller.dispose();
    mock.timers.reset();
  }
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
    actionId: 'interrupt-1',
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
  assert.equal(actions.some((action) => action.type === 'review.resolution.sent'), true);
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
  const advance = first.actions.find((action) => action.type === 'review.draft.record');
  assert.equal(advance?.type, 'review.draft.record');
  if (advance?.type === 'review.draft.record') {
    assert.equal(advance.requestId, 'req-1');
    assert.deepEqual(advance.decision, { reviewId: 'review-1', selectedOptionId: 'approve' });
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
    actionId: 'interrupt-1',
    reviewId: 'review-2',
    selectedOptionId: 'approve',
    decisions: [
      { reviewId: 'review-1', selectedOptionId: 'approve' },
      { reviewId: 'review-2', selectedOptionId: 'approve' },
    ],
  }]);
  assert.equal(final.actions.some((action) => action.type === 'review.resolution.sent'), true);
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
    actionId: 'interrupt-1',
    reviewId: 'review-1',
    selectedOptionId: 'reject',
    decisions: [
      { reviewId: 'review-1', selectedOptionId: 'reject' },
    ],
  }]);
  assert.equal(actions.some((action) => action.type === 'review.resolution.sent'), true);
  assert.equal(actions.some((action) => action.type === 'review.draft.record'), false);
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
  assert.equal(actions.some((action) =>
    action.type === 'message.appended'
  ), true);
});

test('TuiRuntimeController keeps review open when the resolution cannot be sent', () => {
  const { controller, actions, sent } = createController(pendingReviewState(), {
    sendResult: false,
  });

  const submitted = controller.submitReviewResponse({
    id: 'approve',
    label: 'Approve',
    decision: { type: 'approve' },
  });

  assert.equal(submitted, false);
  assert.deepEqual(sent, []);
  assert.equal(actions.some((action) => action.type === 'review.resolution.sent'), false);
  assert.equal(actions.some((action) => action.type === 'message.appended'), true);
});

test('TuiRuntimeController requests review cancellation separately from run interruption', () => {
  const { controller, actions, sent } = createController(pendingReviewState());

  const submitted = controller.requestInterrupt();

  assert.equal(submitted, true);
  assert.deepEqual(sent, [{
    type: 'review.cancel',
    requestId: 'req-1',
    actionId: 'interrupt-1',
  }]);
  assert.deepEqual(actions.find((action) => action.type === 'review.resolution.sent'), {
    type: 'review.resolution.sent',
    requestId: 'req-1',
    actionId: 'interrupt-1',
  });
});

test('TuiRuntimeController sends explicit delegation continuation', () => {
  const harness = createController(idleState());

  assert.equal(
    harness.controller.continueActiveDelegation('apply the new constraints'),
    true,
  );
  const continuation = harness.sent[0];
  assert.equal(continuation?.type, 'chat_request');
  if (continuation?.type === 'chat_request') {
    assert.equal(typeof continuation.requestId, 'string');
    assert.equal(continuation.message, 'apply the new constraints');
    assert.equal(continuation.activeDelegationTransition, 'resume_active');
  }
});

test('TuiRuntimeController explicitly supersedes checkpoint state for ordinary chat', () => {
  const harness = createController(idleState());

  assert.equal(harness.controller.sendChatRequest('answer a new question'), true);
  const request = harness.sent[0];
  assert.equal(request?.type, 'chat_request');
  if (request?.type === 'chat_request') {
    assert.equal(request.message, 'answer a new question');
    assert.equal(
      request.activeDelegationTransition,
      'supersede_active',
    );
  }
});

test('TuiRuntimeController reports transport rejection for continuation', () => {
  const harness = createController(idleState());

  harness.connection.send = () => false;
  assert.equal(harness.controller.continueActiveDelegation('keep going'), false);
});

test('TuiRuntimeController interrupts the resumed run after a review resolution was sent', () => {
  const state = pendingReviewState();
  state.reviewDrafts['interrupt-1']!.resolutionSent = true;
  const { controller, actions, sent } = createController(state);

  assert.equal(controller.requestInterrupt(), true);
  assert.deepEqual(sent, [{
    type: 'run.interrupt',
    requestId: 'req-1',
  }]);
  assert.equal(actions.some((action) => action.type === 'run.interrupting'), false);
});

test('TuiRuntimeController keeps new runs gated after a review resolution was sent', () => {
  const state = pendingReviewState();
  state.reviewDrafts['interrupt-1']!.resolutionSent = true;
  const { controller, actions, sent } = createController(state);

  assert.equal(controller.sendChatRequest('start another run'), false);
  assert.deepEqual(sent, []);
  assert.equal(actions.some((action) => action.type === 'run.start'), false);
});

test('TuiRuntimeController projects chat and studio runs only after transport accepts them', () => {
  const chat = createController(idleState(), { sendResult: false });
  assert.equal(chat.controller.sendChatRequest('hello'), false);
  assert.equal(chat.actions.some((action) => action.type === 'run.start'), false);

  const studio = createController(idleState(), { sendResult: false });
  assert.equal(studio.controller.sendStudioRequest('investigate', 'studio-1'), false);
  assert.equal(studio.actions.some((action) => action.type === 'run.start'), false);

  assert.equal(
    chat.actions.some((action) =>
      action.type === 'message.appended' && action.message.text === '未连接，无法发送'),
    true,
  );
  assert.equal(
    studio.actions.some((action) =>
      action.type === 'message.appended' && action.message.text === '未连接，无法发送'),
    true,
  );
});

test('TuiRuntimeController reports a delayed interrupt without releasing the run', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { controller, actions, sent } = createController(busyRunState());
  try {
    assert.equal(controller.requestInterrupt(), true);
    assert.deepEqual(sent, [{
      type: 'run.interrupt',
      requestId: 'req-1',
    }]);

    mock.timers.tick(9_999);
    assert.equal(
      actions.some((action) =>
        action.type === 'message.appended'
        && action.message.text === '仍在停止，agent 尚未确认；输入会保持锁定。'),
      false,
    );

    mock.timers.tick(1);
    assert.equal(
      actions.filter((action) =>
        action.type === 'message.appended'
        && action.message.text === '仍在停止，agent 尚未确认；输入会保持锁定。').length,
      1,
    );
    assert.equal(actions.some((action) => action.type === 'run.finish'), false);
    assert.equal(controller.sendChatRequest('start too early'), false);
  } finally {
    controller.dispose();
    mock.timers.reset();
  }
});

test('TuiRuntimeController cancels the delayed interrupt notice on an authoritative response', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const harness = createController(busyRunState());
  try {
    assert.equal(harness.controller.requestInterrupt(), true);
    harness.connectionHandlers.onMessage({
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'human_review.requested',
        requestId: 'req-1',
        review: {
          id: 'review-2',
          schemaVersion: 1,
          view: { kind: 'plain', body: 'A new review' },
          options: [],
        },
      },
    });

    mock.timers.tick(10_000);
    assert.equal(
      harness.actions.some((action) =>
        action.type === 'message.appended'
        && action.message.text === '仍在停止，agent 尚未确认；输入会保持锁定。'),
      false,
    );
  } finally {
    harness.controller.dispose();
    mock.timers.reset();
  }
});

test('TuiRuntimeController resets the timeline viewport for new sessions', () => {
  const harness = createController(pendingReviewState());

  harness.controller.startNewSession();

  assert.equal(harness.resetCount, 1);
  assert.deepEqual(harness.actions.slice(0, 2), [
    { type: 'input.set', value: '' },
    { type: 'session.clear', statusNotice: '已创建新会话' },
  ]);
  assert.deepEqual(harness.sent, [{ type: 'new_session' }]);
});

test('TuiRuntimeController correlates model list and selection responses', async () => {
  const harness = createController(idleState());
  const listPromise = harness.controller.listModelProfiles();
  const listRequest = harness.sent[0];
  assert.equal(listRequest?.type, 'model.list');
  if (listRequest?.type !== 'model.list') assert.fail('expected model list request');

  harness.connectionHandlers.onMessage({
    type: 'model.list.result',
    requestId: listRequest.requestId,
    sessionId: 'sess-1',
    defaultProfileId: 'text',
    selectedProfileId: 'text',
    requiredInputModalities: ['text'],
    profiles: [{
      id: 'text',
      label: 'Text',
      inputModalities: ['text'],
      available: true,
      compatible: true,
      issues: [],
    }, {
      id: 'vision',
      label: 'Vision',
      inputModalities: ['text', 'image'],
      available: true,
      compatible: true,
      issues: [],
    }],
  });

  const listed = await listPromise;
  assert.equal(listed.selectedProfileId, 'text');
  assert.deepEqual(listed.requiredInputModalities, ['text']);

  const selectPromise = harness.controller.selectModelProfile('vision');
  const selectRequest = harness.sent[1];
  assert.equal(selectRequest?.type, 'model.select');
  if (selectRequest?.type !== 'model.select') {
    assert.fail('expected model select request');
  }
  const snapshot = {
    version: 3 as const,
    session: {
      sessionId: 'sess-1',
      kind: 'chat' as const,
      runtime: {
        modelProfileId: 'vision',
        modelProfileLabel: 'Vision',
      },
      timeline: [],
      activeRun: null,
    },
  };
  harness.connectionHandlers.onMessage({
    type: 'model.select.result',
    requestId: selectRequest.requestId,
    sessionId: 'sess-1',
    selectedProfileId: 'vision',
    snapshot,
  });

  assert.equal(await selectPromise, snapshot);
  const applied = harness.actions.find(
    (action) => action.type === 'session.snapshot.loaded',
  );
  assert.equal(applied?.type, 'session.snapshot.loaded');
  if (applied?.type === 'session.snapshot.loaded') {
    assert.equal(applied.reason, 'model-select');
    assert.equal(applied.snapshot.session.runtime?.modelProfileId, 'vision');
  }
});

test('TuiRuntimeController exposes model selection errors without applying a snapshot', async () => {
  const harness = createController(idleState());
  const selected = harness.controller.selectModelProfile('text');
  const request = harness.sent[0];
  assert.equal(request?.type, 'model.select');
  if (request?.type !== 'model.select') assert.fail('expected model select request');

  harness.connectionHandlers.onMessage({
    type: 'model.select.error',
    requestId: request.requestId,
    sessionId: 'sess-1',
    modelProfileId: 'text',
    code: 'profile_incompatible',
    message: 'Session requires image input.',
  });

  await assert.rejects(selected, (error: Error & { code?: string }) => (
    error.message === 'Session requires image input.'
    && error.code === 'profile_incompatible'
  ));
  assert.equal(
    harness.actions.some((action) => action.type === 'session.snapshot.loaded'),
    false,
  );
});

test('TuiRuntimeController applies the latest snapshot without resetting inline output before reconnecting', async () => {
  const state = pendingReviewState();
  const events: string[] = [];
  const harness = createController(state, {
    connected: false,
    onConnect: () => events.push('connect'),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (harness.controller as any).localServerClient = {
    isHealthy: async () => true,
    readSessionSnapshot: async () => {
      events.push('snapshot');
      return {
        version: 3,
        session: {
          sessionId: 'sess-1',
          kind: 'chat',
          timeline: [{
            id: 'message:user-1',
            type: 'message',
            role: 'user',
            text: 'hello',
            status: 'completed',
          }],
          activeRun: null,
        },
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (harness.controller as any).reconnect();

  assert.deepEqual(events, ['snapshot', 'connect']);
  assert.equal(harness.resetCount, 0);
  assert.equal(harness.actions[0]?.type, 'session.snapshot.loaded');
  assert.equal(
    harness.actions[0]?.type === 'session.snapshot.loaded'
      ? harness.actions[0].reason
      : undefined,
    'reconnect',
  );
});

test('TuiRuntimeController refreshes stale reviews without resetting inline output', async () => {
  const harness = createController(pendingReviewState());
  const events: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (harness.controller as any).localServerClient = {
    readSessionSnapshot: async () => {
      events.push('snapshot');
      return {
        version: 3,
        session: {
          sessionId: 'sess-1',
          kind: 'chat',
          timeline: [{
            id: 'message:user-1',
            type: 'message',
            role: 'user',
            text: 'hello',
            status: 'completed',
          }],
          activeRun: null,
        },
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
  assert.equal(harness.resetCount, 0);
  assert.equal(harness.actions[0]?.type, 'event.received');
  assert.equal(harness.actions[1]?.type, 'session.snapshot.loaded');
  assert.equal(
    harness.actions[1]?.type === 'session.snapshot.loaded'
      ? harness.actions[1].reason
      : undefined,
    'review-refresh',
  );
});

test('TuiRuntimeController applies completed-message snapshots without resetting inline output', async () => {
  const harness = createController(pendingReviewState());
  const events: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (harness.controller as any).localServerClient = {
    readSessionSnapshot: async () => {
      events.push('snapshot');
      return {
        version: 3,
        session: {
          sessionId: 'sess-1',
          kind: 'chat',
          timeline: [{
            id: 'message:assistant-1',
            type: 'message',
            role: 'assistant',
            text: 'final',
            status: 'completed',
            requestId: 'req-1',
          }],
          activeRun: null,
        },
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
  assert.equal(harness.resetCount, 0);
  assert.equal(harness.actions[0]?.type, 'event.received');
  assert.equal(harness.actions[1]?.type, 'session.snapshot.loaded');
  assert.equal(
    harness.actions[1]?.type === 'session.snapshot.loaded'
      ? harness.actions[1].reason
      : undefined,
    'completion',
  );
});

test('TuiRuntimeController refreshes the session after interruption', async () => {
  const harness = createController(pendingReviewState());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (harness.controller as any).localServerClient = {
    readSessionSnapshot: async () => ({
      version: 3,
      session: {
        sessionId: 'sess-1',
        kind: 'chat',
        timeline: [],
        activeRun: null,
      },
    }),
  };

  harness.connectionHandlers.onMessage({
    type: 'interrupted',
    requestId: 'req-1',
  });
  await new Promise((resolve) => setImmediate(resolve));

  const snapshotAction = harness.actions.find((action) => (
    action.type === 'session.snapshot.loaded'
  ));
  assert.equal(snapshotAction?.type, 'session.snapshot.loaded');
});

test('TuiRuntimeController refreshes the session after a run error', async () => {
  const harness = createController(pendingReviewState());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (harness.controller as any).localServerClient = {
    readSessionSnapshot: async () => ({
      version: 3,
      session: {
        sessionId: 'sess-1',
        kind: 'chat',
        timeline: [],
        activeRun: null,
      },
    }),
  };

  harness.connectionHandlers.onMessage({
    type: 'event',
    requestId: 'req-1',
    event: {
      type: 'error',
      requestId: 'req-1',
      message: 'review already closed',
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const snapshotAction = harness.actions.find((action) => (
    action.type === 'session.snapshot.loaded'
  ));
  assert.equal(snapshotAction?.type, 'session.snapshot.loaded');
});
