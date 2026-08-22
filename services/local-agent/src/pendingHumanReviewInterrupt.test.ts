import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewSpec } from '@pinpawo/pet-agent';
import {
  buildHumanReviewCancelResume,
  buildHumanReviewResume,
  resolvePendingHumanReviewInterrupt,
  routeRunInterruptThroughHumanReview,
  validateHumanReviewResponses,
} from './pendingHumanReviewInterrupt';
import type { AgentRuntimeEvent } from '@pinpawo/agent-session';

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

function reviewRoute(ids: string[], interruptId = 'interrupt-1') {
  return {
    interruptId,
    reviews: ids.map(reviewSpec),
  };
}

test('run interrupt routing reloads the pending interrupt from checkpoint', async () => {
  const route = { ...reviewRoute(['review-1'], 'interrupt-1'), requestId: 'req-1' };
  const cancelled: typeof route[] = [];

  assert.equal(await routeRunInterruptThroughHumanReview({
    recover: async () => route,
    cancelPending: async (pendingRoute) => {
      cancelled.push(pendingRoute);
    },
  }), true);
  assert.deepEqual(cancelled, [route]);

  assert.equal(await routeRunInterruptThroughHumanReview({
    recover: async () => null,
    cancelPending: async (pendingRoute) => {
      cancelled.push(pendingRoute);
    },
  }), false);
  assert.deepEqual(cancelled, [route]);
});

test('human review interrupt rejects partial approval resumes', () => {
  const route = reviewRoute(['review-1', 'review-2']);

  assert.throws(() => validateHumanReviewResponses(route, {
    type: 'human_review_response',
    requestId: 'req-1',
    interruptId: 'interrupt-1',
    responses: [
      { interactionId: 'review-1', selectedOptionId: 'approve' },
    ],
  }));
});

test('human review interrupt resumes complete approvals as one payload', () => {
  const route = reviewRoute(['review-1', 'review-2'], 'interrupt-1');
  const decisions = validateHumanReviewResponses(route, {
    type: 'human_review_response',
    requestId: 'req-1',
    interruptId: 'interrupt-1',
    responses: [
      { interactionId: 'review-1', selectedOptionId: 'approve' },
      { interactionId: 'review-2', selectedOptionId: 'approve' },
    ],
  });

  assert.deepEqual(buildHumanReviewResume(route, decisions), {
    'interrupt-1': {
      decisions,
    },
  });
});

test('human review interrupt resolves a single interaction as batch shape', () => {
  const route = reviewRoute(['review-1'], 'interrupt-1');
  const decisions = validateHumanReviewResponses(route, {
    type: 'human_review_response',
    requestId: 'req-1',
    interruptId: 'interrupt-1',
    responses: [{ interactionId: 'review-1', selectedOptionId: 'approve' }],
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

test('human review interrupt rejects decisions for mismatched interaction order', () => {
  const route = reviewRoute(['review-1', 'review-2']);

  assert.throws(() => validateHumanReviewResponses(route, {
    type: 'human_review_response',
    requestId: 'req-1',
    interruptId: 'interrupt-1',
    responses: [
      { interactionId: 'review-2', selectedOptionId: 'approve' },
      { interactionId: 'review-1', selectedOptionId: 'approve' },
    ],
  }));
});

test('human review interrupt reloads checkpoint authority for every attempt', async () => {
  const route = {
    ...reviewRoute(['review-1'], 'interrupt-1'),
    requestId: 'req-1',
  };
  let pending: typeof route | null = route;
  const runs: unknown[] = [];
  const events: AgentRuntimeEvent[] = [];
  let closed = 0;
  const message = {
    type: 'human_review_response' as const,
    requestId: 'req-1',
    interruptId: 'interrupt-1',
    responses: [{ interactionId: 'review-1', selectedOptionId: 'approve' }],
  };
  const resolve = () => resolvePendingHumanReviewInterrupt({
    message,
    recover: async () => pending,
    emitClosed: () => {
      closed += 1;
    },
    emitEvent: (event) => {
      events.push(event);
    },
    isConnected: () => true,
    run: async (_route, resume, source) => {
      runs.push({ resume, source });
      pending = null;
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
      interactionId: 'review-1',
      selectedOptionId: 'approve',
      decisionCount: 1,
    },
  }]);
  assert.deepEqual(events, []);
  assert.equal(closed, 1);
});

test('a same-id re-ask is read from the latest checkpoint', async () => {
  const route = { ...reviewRoute(['review-1'], 'interrupt-1'), requestId: 'req-1' };
  const reasked = { ...reviewRoute(['review-2'], 'interrupt-1'), requestId: 'req-1' };
  let pending = route;

  await resolvePendingHumanReviewInterrupt({
    message: {
      type: 'human_review_response',
      requestId: 'req-1',
      interruptId: 'interrupt-1',
      responses: [{ interactionId: 'review-1', selectedOptionId: 'approve' }],
    },
    recover: async () => pending,
    emitClosed: () => undefined,
    emitEvent: () => undefined,
    isConnected: () => true,
    run: async () => {
      pending = reasked;
      return 'waiting_human';
    },
  });

  const cancelled: typeof reasked[] = [];
  assert.equal(await routeRunInterruptThroughHumanReview({
    recover: async () => pending,
    cancelPending: async (pendingRoute) => {
      cancelled.push(pendingRoute);
    },
  }), true);
  assert.deepEqual(cancelled, [reasked]);
});

test('human review response validation runs before the route boundary guard', async () => {
  const route = {
    ...reviewRoute(['review-1'], 'interrupt-1'),
    requestId: 'req-1',
  };
  const events: AgentRuntimeEvent[] = [];
  let guardCalls = 0;

  await resolvePendingHumanReviewInterrupt({
    message: {
      type: 'human_review_response',
      requestId: 'req-1',
      interruptId: 'interrupt-1',
      responses: [{ interactionId: 'review-stale', selectedOptionId: 'approve' }],
    },
    recover: async () => route,
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
  const runs: unknown[] = [];

  await resolvePendingHumanReviewInterrupt({
    message: {
      type: 'review.cancel',
      requestId: 'req-1',
      interruptId: 'interrupt-1',
    },
    recover: async () => route,
    emitClosed: () => undefined,
    emitEvent: () => undefined,
    isConnected: () => true,
    run: async (_route, resume, source) => {
      runs.push({ resume, source });
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
      interactionId: 'review-1',
      decisionCount: 0,
    },
  }]);
});

test('human review rejection queues the same checkpoint interruption as cancellation', async () => {
  const route = {
    ...reviewRoute(['review-1'], 'interrupt-1'),
    requestId: 'req-1',
  };
  const runs: unknown[] = [];

  await resolvePendingHumanReviewInterrupt({
    message: {
      type: 'human_review_response',
      requestId: 'req-1',
      interruptId: 'interrupt-1',
      responses: [{ interactionId: 'review-1', selectedOptionId: 'reject' }],
    },
    recover: async () => route,
    emitClosed: () => undefined,
    emitEvent: () => undefined,
    isConnected: () => true,
    run: async (_route, resume, source) => {
      runs.push({ resume, source });
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
      interactionId: 'review-1',
      selectedOptionId: 'reject',
      decisionCount: 1,
      interruptRun: true,
    },
  }]);
});

test('a fatal run failure leaves checkpoint authority available for a later retry', async () => {
  const route = { ...reviewRoute(['review-1'], 'interrupt-1'), requestId: 'req-1' };
  let runs = 0;

  const resolve = () => resolvePendingHumanReviewInterrupt({
    message: {
      type: 'review.cancel',
      requestId: 'req-1',
      interruptId: 'interrupt-1',
    },
    recover: async () => route,
    emitClosed: () => {},
    emitEvent: () => {},
    isConnected: () => true,
    run: async () => {
      runs += 1;
      return runs === 1 ? 'fatal_failed' : 'completed';
    },
  });

  await resolve();
  await resolve();
  assert.equal(runs, 2);
});

test('a recoverable run failure re-reads the pending interrupt on retry', async () => {
  const route = { ...reviewRoute(['review-1'], 'interrupt-1'), requestId: 'req-1' };
  let runs = 0;

  const resolve = () => resolvePendingHumanReviewInterrupt({
    message: {
      type: 'review.cancel',
      requestId: 'req-1',
      interruptId: 'interrupt-1',
    },
    recover: async () => route,
    emitClosed: () => {},
    emitEvent: () => {},
    isConnected: () => true,
    run: async () => {
      runs += 1;
      return runs === 1 ? 'failed' : 'completed';
    },
  });

  await resolve();
  await resolve();
  assert.equal(runs, 2);
});
