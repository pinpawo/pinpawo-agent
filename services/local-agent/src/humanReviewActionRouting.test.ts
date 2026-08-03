import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewSpec } from '@pinpawo/pet-agent';
import {
  buildHumanReviewCancelResume,
  buildHumanReviewRejectResume,
  buildHumanReviewResume,
  resolveHumanReviewAction,
  validateHumanReviewDecisions,
} from './humanReviewActionRouting';
import type { AgentRuntimeEvent } from '@pinpawo/agent-session';
import { ReviewResolutionLifecycle } from './reviewResolutionLifecycle';

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
  const lifecycle = new ReviewResolutionLifecycle<typeof route>();
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

test('human review response validation runs before the route boundary guard', async () => {
  const route = {
    ...reviewRoute(['review-1'], 'interrupt-1'),
    requestId: 'req-1',
  };
  const lifecycle = new ReviewResolutionLifecycle<typeof route>();
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
  const lifecycle = new ReviewResolutionLifecycle<typeof route>();
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
  const lifecycle = new ReviewResolutionLifecycle<typeof route>();
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
