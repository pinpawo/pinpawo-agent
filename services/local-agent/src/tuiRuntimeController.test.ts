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
    runRoute: { 'req-1': 'sess-1' },
    input: { text: '', cursorOffset: 0, focused: true, history: createComposerHistoryState() },
    sessions: {
      'sess-1': {
        id: 'sess-1',
        kind: 'chat',
        actor: { label: 'Pet', summary: 'summary' },
        runtime: {},
        history: [],
        timeline: [],
        tokenUsage: null,
        activeRun: {
          requestId: 'req-1',
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

test.skip('contract: reconnect reconciles server-completed runs through session snapshot', async () => {
  const harness = createController(pendingReviewState());
  let connected = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (harness.controller as any).localServerClient = {
    isHealthy: async () => true,
    readRuntime: async () => null,
    readHistory: async () => [{
      id: 'assistant-final',
      kind: 'assistant',
      text: 'final answer from checkpoint',
    }],
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (harness.controller as any).wsClient = {
    hasSocket: () => false,
    isConnected: () => false,
    connect: () => {
      connected = true;
    },
    disconnect: () => {},
    send: () => {},
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (harness.controller as any).reconnect();

  assert.equal(connected, true);
  assert.equal(
    harness.actions.some((action) => String(action.type) === TUI_CORE_TARGET_ACTIONS.sessionSnapshotLoaded),
    true,
  );
  assert.equal(harness.actions.some((action) => action.type === 'session.replace_history'), false);
});

test.skip('contract: reconnect restores pending review through session snapshot', async () => {
  const harness = createController(pendingReviewState());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (harness.controller as any).localServerClient = {
    isHealthy: async () => true,
    readRuntime: async () => null,
    readHistory: async () => [],
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (harness.controller as any).wsClient = {
    hasSocket: () => false,
    isConnected: () => false,
    connect: () => {},
    disconnect: () => {},
    send: () => {},
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (harness.controller as any).reconnect();

  assert.equal(
    harness.actions.some((action) => String(action.type) === TUI_CORE_TARGET_ACTIONS.sessionSnapshotLoaded),
    true,
  );
  assert.equal(
    harness.actions.some((action) => JSON.stringify(action).includes('"pendingReview"')),
    true,
  );
});

test.skip('contract: resume session reconciles through session snapshot', async () => {
  const harness = createController(pendingReviewState());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (harness.controller as any).localServerClient = {
    resumeSession: async () => ({
      source: 'resume',
      session: { id: 'chat:one', title: 'One', active: true },
      timeline: [{ id: 'assistant-final', role: 'assistant', text: 'welcome back' }],
      runs: [],
    }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (harness.controller as any).resumeSession('chat:one');

  assert.equal(
    harness.actions.some((action) => String(action.type) === TUI_CORE_TARGET_ACTIONS.sessionSnapshotLoaded),
    true,
  );
  assert.equal(harness.actions.some((action) => action.type === 'session.clear'), false);
  assert.equal(harness.actions.some((action) => action.type === 'session.replace_history'), false);
});
