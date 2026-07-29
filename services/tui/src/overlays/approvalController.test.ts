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
    reviewId: 'review-1',
    selectedOptionId: 'approve',
  };
  const secondDecision: ReviewResponse = {
    reviewId: 'review-2',
    selectedOptionId: 'approve',
  };
  const sessionController = new FakeReviewSessionController();
  sessionController.submitResults.push({
    ok: true,
    status: 'advanced',
    decision: firstDecision,
    decisions: [firstDecision],
  }, {
    ok: true,
    status: 'sent',
    decision: secondDecision,
    decisions: [firstDecision, secondDecision],
  });
  const timers: Array<{
    callback: () => void;
    handle: ReturnType<typeof setTimeout>;
  }> = [];
  const changes: string[] = [];
  const controller = new ApprovalController({
    sessionController,
    getWidth: () => 80,
    onChange: (state) => changes.push(state.phase),
    submissionTimeoutMs: 25,
    setTimer: (callback) => {
      const handle = {} as ReturnType<typeof setTimeout>;
      timers.push({ callback, handle });
      return handle;
    },
    clearTimer: (handle) => {
      const index = timers.findIndex((timer) => timer.handle === handle);
      if (index >= 0) timers.splice(index, 1);
    },
  });

  controller.sync(waitingReview(), 'ready');
  controller.handle('submit');
  const advanced = controller.getState();
  assert.equal(advanced.phase, 'ready');
  assert.equal(advanced.reviewIndex, 1);

  controller.handle('submit');
  assert.equal(controller.getState().phase, 'resolution-sent');
  assert.equal(timers.length, 1);
  timers[0]?.callback();
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
  ]);
});

test('approval controller preserves the one-shot resolution gate when connection changes', () => {
  const sessionController = new FakeReviewSessionController();
  const decision: ReviewResponse = {
    reviewId: 'review-1',
    selectedOptionId: 'approve',
  };
  sessionController.submitResults.push({
    ok: true,
    status: 'sent',
    decision,
    decisions: [decision],
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

test('approval controller sends canonical cancellation for the active action', () => {
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
    requestId: 'request-1',
    actionId: 'action-1',
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
    state: 'waiting_review',
    reviewAction: {
      actionId: 'action-1',
      reviews,
    },
  };
}

function review(id: string): ReviewSpec {
  return {
    id,
    schemaVersion: 1,
    view: {
      kind: 'plain',
      body: `Review ${id}`,
    },
    options: [{
      id: 'approve',
      label: 'Approve',
      variant: 'primary',
      decision: { type: 'approve' },
    }],
  };
}
