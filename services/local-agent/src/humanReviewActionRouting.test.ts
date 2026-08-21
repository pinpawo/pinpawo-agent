import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewSpec } from '@pinpawo/pet-agent';
import {
  buildHumanReviewCancelResume,
  buildHumanReviewRejectResume,
  buildHumanReviewResume,
  resolveHumanReviewAction,
  routeRunInterruptThroughHumanReview,
  validateHumanReviewDecisions,
} from './humanReviewActionRouting';
import type { AgentRuntimeEvent } from '@pinpawo/agent-session';
import { ReviewResolutionClaims } from './reviewResolutionClaims';

function reviewSpec(id: string): ReviewSpec {
  return {
    id,
    schemaVersion: 1,
    view: { kind: 'plain', body: `Review ${id}` },
    options: [
      {
        id: 'approve',
        label: 'Approve',
        decision: { type: 'approve' },
      },
      {
        id: 'reject',
        label: 'Reject',
        decision: { type: 'reject' },
      },
    ],
  };
}

function reviewRoute(ids: string[], interruptId?: string) {
  return {
    actionId: interruptId ?? `request:req-1:reviews:${ids.join(',')}`,
    ...(interruptId ? { interruptId } : {}),
    reviews: ids.map(reviewSpec),
  };
}

test('run interrupt routing normalizes pending and resolving review states', async () => {
  const lifecycle = new ReviewResolutionClaims<ReturnType<typeof reviewRoute> & {
    requestId: string;
  }>();
  const route = { ...reviewRoute(['review-1'], 'interrupt-1'), requestId: 'req-1' };
  const cancelled: typeof route[] = [];
  lifecycle.register(route);

  assert.equal(await routeRunInterruptThroughHumanReview({
    lifecycle,
    requestId: 'req-1',
    cancelPending: async (pendingRoute) => {
      cancelled.push(pendingRoute);
    },
  }), 'cancelled_pending');
  assert.deepEqual(cancelled, [route]);

  const resolution = await lifecycle.claim(route, async () => null);
  assert.ok(resolution);
  assert.equal(await routeRunInterruptThroughHumanReview({
    lifecycle,
    requestId: 'req-1',
    cancelPending: async (pendingRoute) => {
      cancelled.push(pendingRoute);
    },
  }), 'queued_for_resolution');
  assert.deepEqual(cancelled, [route]);
  assert.equal(lifecycle.checkpoint('req-1'), true);

  assert.equal(await routeRunInterruptThroughHumanReview({
    lifecycle,
    requestId: 'req-unknown',
    cancelPending: async (pendingRoute) => {
      cancelled.push(pendingRoute);
    },
  }), 'unhandled');
  assert.deepEqual(cancelled, [route]);
});

test('human review action routing resumes once for a rejected first decision', () => {
  const route = reviewRoute(['review-1', 'review-2'], 'interrupt-1');

  assert.deepEqual(buildHumanReviewRejectResume(route, 'reject'), {
    'interrupt-1': {
      decisions: [
        { reviewId: 'review-1', selectedOptionId: 'reject' },
      ],
    },
  });
});

test('human review action routing rejects partial approval resumes', () => {
  const route = reviewRoute(['review-1', 'review-2']);

  assert.throws(() => validateHumanReviewDecisions(route, {
    type: 'human_review_response',
    requestId: 'req-1',
    reviewId: 'review-1',
    selectedOptionId: 'approve',
    decisions: [
      { reviewId: 'review-1', selectedOptionId: 'approve' },
    ],
  }));
});

test('human review action routing resumes complete approvals as one review action', () => {
  const route = reviewRoute(['review-1', 'review-2'], 'interrupt-1');
  const decisions = validateHumanReviewDecisions(route, {
    type: 'human_review_response',
    requestId: 'req-1',
    reviewId: 'review-2',
    selectedOptionId: 'approve',
    decisions: [
      { reviewId: 'review-1', selectedOptionId: 'approve' },
      { reviewId: 'review-2', selectedOptionId: 'approve' },
    ],
  });

  assert.deepEqual(buildHumanReviewResume(route, decisions), {
    'interrupt-1': {
      decisions,
    },
  });
});

test('human review action routing resolves single-review resume as batch shape', () => {
  const route = reviewRoute(['review-1'], 'interrupt-1');
  const decisions = validateHumanReviewDecisions(route, {
    type: 'human_review_response',
    requestId: 'req-1',
    reviewId: 'review-1',
    selectedOptionId: 'approve',
  });

  assert.deepEqual(buildHumanReviewResume(route, decisions), {
    'interrupt-1': {
      decisions: [{
        reviewId: 'review-1',
        selectedOptionId: 'approve',
      }],
    },
  });
});

test('human review action routing rejects decisions for mismatched review order', () => {
  const route = reviewRoute(['review-1', 'review-2']);

  assert.throws(() => validateHumanReviewDecisions(route, {
    type: 'human_review_response',
    requestId: 'req-1',
    reviewId: 'review-2',
    selectedOptionId: 'approve',
    decisions: [
      { reviewId: 'review-2', selectedOptionId: 'approve' },
      { reviewId: 'review-1', selectedOptionId: 'approve' },
    ],
  }));
});

test('human review action routing fails closed when the interrupt identity is missing', () => {
  const route = reviewRoute(['review-1', 'review-2']);

  assert.deepEqual(buildHumanReviewResume(route, [
    { reviewId: 'review-1', selectedOptionId: 'approve' },
    { reviewId: 'review-2', selectedOptionId: 'approve' },
  ]), {
    decisions: [
      { reviewId: 'review-1', selectedOptionId: 'reject' },
      { reviewId: 'review-2', selectedOptionId: 'reject' },
    ],
  });
});

test('human review action resolution owns validation, resume, and consumption', async () => {
  const route = {
    ...reviewRoute(['review-1'], 'interrupt-1'),
    requestId: 'req-1',
    rejectOptionId: 'reject',
  };
  const lifecycle = new ReviewResolutionClaims<typeof route>();
  lifecycle.register(route);
  const runs: unknown[] = [];
  const events: AgentRuntimeEvent[] = [];
  let closed = 0;
  const message = {
    type: 'human_review_response' as const,
    requestId: 'req-1',
    actionId: 'interrupt-1',
    reviewId: 'review-1',
    selectedOptionId: 'approve',
  };
  const resolve = () => resolveHumanReviewAction({
    lifecycle,
    message,
    recover: async () => null,
    emitClosed: () => {
      closed += 1;
    },
    emitEvent: (event) => {
      events.push(event);
    },
    isConnected: () => true,
    run: async (_route, resume, source) => {
      runs.push({ resume, source });
      return 'completed';
    },
  });

  await resolve();
  await resolve();

  assert.deepEqual(runs, [{
    resume: {
      'interrupt-1': {
        decisions: [{ reviewId: 'review-1', selectedOptionId: 'approve' }],
      },
    },
    source: {
      type: 'human_review_response',
      reviewId: 'review-1',
      selectedOptionId: 'approve',
      decisionCount: 1,
    },
  }]);
  assert.deepEqual(events, []);
  assert.equal(closed, 1);
});

test('a same-id review registered by the resumed run remains interruptible', async () => {
  const lifecycle = new ReviewResolutionClaims<ReturnType<typeof reviewRoute> & {
    requestId: string;
  }>();
  const route = { ...reviewRoute(['review-1'], 'interrupt-1'), requestId: 'req-1' };
  const reasked = { ...reviewRoute(['review-2'], 'interrupt-1'), requestId: 'req-1' };
  lifecycle.register(route);

  await resolveHumanReviewAction({
    lifecycle,
    message: {
      type: 'human_review_response',
      requestId: 'req-1',
      actionId: 'interrupt-1',
      reviewId: 'review-1',
      selectedOptionId: 'approve',
    },
    recover: async () => null,
    emitClosed: () => undefined,
    emitEvent: () => undefined,
    isConnected: () => true,
    run: async () => {
      // runChatSession registers the final pending review before returning
      // waiting_human. LangGraph can reuse the interrupt id for a re-ask.
      lifecycle.register(reasked, { observedPending: true });
      return 'waiting_human';
    },
  });

  const cancelled: typeof reasked[] = [];
  assert.equal(await routeRunInterruptThroughHumanReview({
    lifecycle,
    requestId: 'req-1',
    cancelPending: async (pendingRoute) => {
      cancelled.push(pendingRoute);
    },
  }), 'cancelled_pending');
  assert.deepEqual(cancelled, [reasked]);
});

test('human review response validation runs before the route boundary guard', async () => {
  const route = {
    ...reviewRoute(['review-1'], 'interrupt-1'),
    requestId: 'req-1',
  };
  const lifecycle = new ReviewResolutionClaims<typeof route>();
  lifecycle.register(route);
  const events: AgentRuntimeEvent[] = [];
  let guardCalls = 0;

  await resolveHumanReviewAction({
    lifecycle,
    message: {
      type: 'human_review_response',
      requestId: 'req-1',
      actionId: 'interrupt-1',
      reviewId: 'review-stale',
      selectedOptionId: 'approve',
    },
    recover: async () => null,
    emitClosed: () => undefined,
    emitEvent: (event) => {
      events.push(event);
    },
    acceptRoute: () => {
      guardCalls += 1;
      return false;
    },
    isConnected: () => true,
    run: async () => 'completed',
  });

  assert.equal(guardCalls, 0);
  assert.equal(
    (events[0] as Extract<AgentRuntimeEvent, { type: 'error' }> | undefined)?.code,
    'review_stale',
  );
});

test('human review cancellation interrupts an approve-only review without fabricating a decision', async () => {
  const route = {
    ...reviewRoute(['review-1'], 'interrupt-1'),
    requestId: 'req-1',
  };
  const lifecycle = new ReviewResolutionClaims<typeof route>();
  lifecycle.register(route);
  const runs: unknown[] = [];

  await resolveHumanReviewAction({
    lifecycle,
    message: {
      type: 'review.cancel',
      requestId: 'req-1',
      actionId: 'interrupt-1',
    },
    recover: async () => null,
    emitClosed: () => undefined,
    emitEvent: () => undefined,
    isConnected: () => true,
    run: async (_route, resume, source) => {
      runs.push({ resume, source });
      assert.equal(lifecycle.checkpoint('req-1'), true);
      return 'interrupted';
    },
  });

  assert.deepEqual(buildHumanReviewCancelResume(route), {
    'interrupt-1': { action: 'interrupt_run' },
  });
  assert.deepEqual(runs, [{
    resume: {
      'interrupt-1': { action: 'interrupt_run' },
    },
    source: {
      type: 'review.cancel',
      reviewId: 'review-1',
      decisionCount: 0,
    },
  }]);
  assert.deepEqual(lifecycle.routes(), []);
});

test('human review rejection queues the same checkpoint interruption as cancellation', async () => {
  const route = {
    ...reviewRoute(['review-1'], 'interrupt-1'),
    requestId: 'req-1',
  };
  const lifecycle = new ReviewResolutionClaims<typeof route>();
  lifecycle.register(route);
  const runs: unknown[] = [];

  await resolveHumanReviewAction({
    lifecycle,
    message: {
      type: 'human_review_response',
      requestId: 'req-1',
      actionId: 'interrupt-1',
      reviewId: 'review-1',
      selectedOptionId: 'reject',
    },
    recover: async () => null,
    emitClosed: () => undefined,
    emitEvent: () => undefined,
    isConnected: () => true,
    run: async (_route, resume, source) => {
      runs.push({ resume, source });
      assert.equal(lifecycle.checkpoint('req-1'), true);
      return 'interrupted';
    },
  });

  assert.deepEqual(runs, [{
    resume: {
      'interrupt-1': {
        decisions: [{ reviewId: 'review-1', selectedOptionId: 'reject' }],
      },
    },
    source: {
      type: 'human_review_response',
      reviewId: 'review-1',
      selectedOptionId: 'reject',
      decisionCount: 1,
      interruptRun: true,
    },
  }]);
  assert.deepEqual(lifecycle.routes(), []);
});

// Regression: a model-level failure (exhausted quota) used to leave the review
// action available, so the cancelled review was immediately re-offered to the
// user and cancelling could never terminate the run.
test('a fatal run failure consumes the review action instead of re-offering it', async () => {
  const lifecycle = new ReviewResolutionClaims<ReturnType<typeof reviewRoute> & {
    requestId: string;
  }>();
  const route = { ...reviewRoute(['review-1'], 'interrupt-1'), requestId: 'req-1' };
  lifecycle.register(route);

  await resolveHumanReviewAction({
    lifecycle,
    message: { type: 'review.cancel', requestId: 'req-1' } as never,
    recover: async () => null,
    emitClosed: () => {},
    emitEvent: () => {},
    isConnected: () => true,
    run: async () => 'fatal_failed',
  });

  assert.deepEqual(lifecycle.routes(), []);

  // The action stays consumed even though the unchanged checkpoint still
  // reports it, so a repeated cancel cannot revive the review.
  const revived = await lifecycle.claim(
    { requestId: 'req-1', actionId: route.actionId },
    async () => route,
  );
  assert.equal(revived, null);
});

test('a recoverable run failure keeps the review action available for a retry', async () => {
  const lifecycle = new ReviewResolutionClaims<ReturnType<typeof reviewRoute> & {
    requestId: string;
  }>();
  const route = { ...reviewRoute(['review-1'], 'interrupt-1'), requestId: 'req-1' };
  lifecycle.register(route);

  await resolveHumanReviewAction({
    lifecycle,
    message: { type: 'review.cancel', requestId: 'req-1' } as never,
    recover: async () => null,
    emitClosed: () => {},
    emitEvent: () => {},
    isConnected: () => true,
    run: async () => 'failed',
  });

  // A recoverable failure must NOT consume the action: the review is still
  // pending, so the next attempt can resolve it normally.
  const retried = await lifecycle.claim(
    { requestId: 'req-1' },
    async () => route,
  );
  assert.ok(retried, 'a recoverable failure must leave the review resolvable');
  assert.equal(retried?.actionId, route.actionId);
});
