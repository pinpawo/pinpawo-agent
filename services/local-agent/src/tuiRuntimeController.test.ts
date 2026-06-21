import assert from 'node:assert/strict';
import test from 'node:test';
import { TuiRuntimeController } from './tui/TuiRuntimeController';
import { TUI_CORE_TARGET_ACTIONS } from './tui/contracts/tuiCoreContract';
import { createComposerHistoryState } from './tui/input/composerHistory';
import type { TuiAction, TuiState } from './tui/state/tuiState';

function pendingReviewState(): TuiState {
  return {
    connection: { status: 'ready', message: 'ready' },
    focusedSessionId: 'sess-1',
    runs: {
      'req-1': {
        requestId: 'req-1',
        sessionId: 'sess-1',
        kind: 'chat',
        phase: 'waiting_human',
        timelineEntryIds: [],
        pendingReview: {
          requestId: 'req-1',
          review: {
            id: 'review-1',
            schemaVersion: 1,
            view: { kind: 'plain', body: 'Need review' },
            options: [],
          },
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
        tokenUsage: null,
        activeRunId: 'req-1',
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
  }]);
  assert.equal(actions.some((action) => action.type === 'review.response.resume'), true);
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
  assert.equal(actions.some((action) => action.type === 'history.append'), true);
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
          id: 'history:user-1',
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
