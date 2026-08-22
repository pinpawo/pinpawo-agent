import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AgentRunView,
  ReviewResponse,
  ReviewSpec,
} from '@pinpawo/agent-session';
import type {
  CancelReviewResult,
  SubmitReviewResponseResult,
} from '../session/sessionController';
import { ApprovalController } from './approvalController';

test('approval controller keeps the one-shot resolution gate after a wait timeout', () => {
  const firstDecision: ReviewResponse = {
    interactionId: 'review-1',
    selectedOptionId: 'approve',
  };
  const secondDecision: ReviewResponse = {
    interactionId: 'review-2',
    selectedOptionId: 'approve',
  };
  const sessionController = new FakeReviewSessionController();
  sessionController.submitResults.push({
    ok: true,
    status: 'advanced',
    decision: firstDecision,
    responses: [firstDecision],
  }, {
    ok: true,
    status: 'sent',
    decision: secondDecision,
    responses: [firstDecision, secondDecision],
  });
  const timers: Array<{
    callback: () => void;
    delayMs: number;
    handle: ReturnType<typeof setTimeout>;
  }> = [];
  const changes: string[] = [];
  const controller = new ApprovalController({
    sessionController,
    getWidth: () => 80,
    onChange: (state) => changes.push(state.phase),
    submissionTimeoutMs: 25,
    setTimer: (callback, delayMs) => {
      const handle = {} as ReturnType<typeof setTimeout>;
      timers.push({ callback, delayMs, handle });
      return handle;
    },
    clearTimer: (handle) => {
      const index = timers.findIndex((timer) => timer.handle === handle);
      if (index >= 0) timers.splice(index, 1);
    },
  });

  controller.sync(waitingReview(), 'ready');
  assert.equal(timers.length, 0);
  controller.handle('submit');
  const advanced = controller.getState();
  assert.equal(advanced.phase, 'ready');
  assert.equal(advanced.reviewIndex, 1);

  controller.handle('submit');
  assert.equal(controller.getState().phase, 'resolution-sent');
  assert.equal(timers.length, 2);
  runTimer(timers, 240);
  const pulsing = controller.getState();
  assert.equal(
    pulsing.phase === 'closed'
      ? null
      : pulsing.submissionFrame,
    1,
  );
  runTimer(timers, 25);
  const timedOut = controller.getState();
  assert.equal(timedOut.phase, 'resolution-sent');
  assert.match(timedOut.message ?? '', /authoritative review state/);
  controller.handle('submit');
  assert.equal(sessionController.submitCalls.length, 2);
  assert.deepEqual(changes, [
    'ready',
    'ready',
    'resolution-sent',
    'resolution-sent',
    'resolution-sent',
  ]);
  controller.sync(null, 'ready');
  assert.equal(timers.length, 0);
});

test('approval controller preserves the one-shot resolution gate when connection changes', () => {
  const sessionController = new FakeReviewSessionController();
  const decision: ReviewResponse = {
    interactionId: 'review-1',
    selectedOptionId: 'approve',
  };
  sessionController.submitResults.push({
    ok: true,
    status: 'sent',
    decision,
    responses: [decision],
  });
  const cleared: ReturnType<typeof setTimeout>[] = [];
  const controller = new ApprovalController({
    sessionController,
    getWidth: () => 80,
    onChange: () => undefined,
    setTimer: () => ({}) as ReturnType<typeof setTimeout>,
    clearTimer: (handle) => cleared.push(handle),
  });
  const run = waitingReview([review('review-1')]);
  controller.sync(run, 'ready');
  controller.handle('submit');
  assert.equal(controller.getState().phase, 'resolution-sent');

  controller.sync(run, 'reconnecting');
  const disconnected = controller.getState();
  assert.equal(disconnected.phase, 'resolution-sent');
  assert.equal(cleared.length, 1);
  assert.match(disconnected.message ?? '', /connection changed/i);
});

test('approval controller sends canonical cancellation for the pending interrupt', () => {
  const sessionController = new FakeReviewSessionController();
  const controller = new ApprovalController({
    sessionController,
    getWidth: () => 80,
    onChange: () => undefined,
    setTimer: () => ({}) as ReturnType<typeof setTimeout>,
  });
  controller.sync(waitingReview([review('review-1')]), 'ready');
  controller.handle('cancel');

  assert.deepEqual(sessionController.cancelCalls, [{
    interruptId: 'pendingInterrupt-1',
  }]);
  assert.equal(controller.getState().phase, 'resolution-sent');
  controller.markInterruptSent();
  const interrupted = controller.getState();
  assert.equal(
    interrupted.phase === 'closed' ? false : interrupted.interruptSent,
    true,
  );
  controller.destroy();
  assert.equal(controller.getState().phase, 'closed');
});

class FakeReviewSessionController {
  submitResults: SubmitReviewResponseResult[] = [];
  submitCalls: unknown[] = [];
  cancelCalls: unknown[] = [];
  cancelResult: CancelReviewResult = { ok: true };

  submitReviewResponse(params: unknown) {
    this.submitCalls.push(params);
    return this.submitResults.shift() ?? {
      ok: false as const,
      reason: 'send-failed' as const,
    };
  }

  cancelReview(params: unknown) {
    this.cancelCalls.push(params);
    return this.cancelResult;
  }
}

function waitingReview(
  reviews = [review('review-1'), review('review-2')],
): AgentRunView {
  return {
    requestId: 'request-1',
    state: 'pending_interrupt',
    pendingInterrupt: {
      interruptId: 'pendingInterrupt-1',
      payload: { kind: 'human_review', interactions: reviews },
    },
  };
}

function review(id: string): ReviewSpec {
  return {
    interactionId: id,
    schemaVersion: 2,
    view: {
      kind: 'plain',
      body: `Review ${id}`,
    },
    options: [{
      id: 'approve',
      label: 'Approve',
      variant: 'primary',
      batchSubmission: 'defer',
    }],
  };
}

function runTimer(
  timers: Array<{
    callback: () => void;
    delayMs: number;
    handle: ReturnType<typeof setTimeout>;
  }>,
  delayMs: number,
) {
  const index = timers.findIndex((timer) => timer.delayMs === delayMs);
  assert.notEqual(index, -1, `timer ${delayMs}ms was not scheduled`);
  const [timer] = timers.splice(index, 1);
  timer?.callback();
}
