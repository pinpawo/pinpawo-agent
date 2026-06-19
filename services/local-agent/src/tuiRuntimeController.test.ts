import assert from 'node:assert/strict';
import test from 'node:test';
import { TuiRuntimeController } from './tui/TuiRuntimeController';
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
          assistantDraft: '',
          subagentDraft: '',
          activeOperations: [],
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
  const controller = new TuiRuntimeController({
    actorId: 'pet-1',
    localServerPort: 0,
    dispatch: (action) => actions.push(action),
    getState: () => state,
    setNow: () => {},
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (controller as any).wsClient = {
    isConnected: () => true,
    send: (message: unknown) => sent.push(message),
    disconnect: () => {},
  };
  return { controller, actions, sent };
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
