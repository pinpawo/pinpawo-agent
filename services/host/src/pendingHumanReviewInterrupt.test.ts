import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewSpec } from '@pinpawo/pet-agent';
import {
  buildHumanReviewCancelResumeValue,
  buildHumanReviewResumeValue,
  resolvePendingHumanReviewInterrupt,
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

test('human review interrupt rejects partial approval resumes', () => {
  const route = reviewRoute(['review-1', 'review-2']);

  assert.throws(() => validateHumanReviewResponses(route, [
      { interactionId: 'review-1', selectedOptionId: 'approve' },
    ]));
});

test('human review interrupt resumes complete approvals as one payload', () => {
  const route = reviewRoute(['review-1', 'review-2'], 'interrupt-1');
  const decisions = validateHumanReviewResponses(route, [
      { interactionId: 'review-1', selectedOptionId: 'approve' },
      { interactionId: 'review-2', selectedOptionId: 'approve' },
    ]);

  // The value carries the decisions only; the interrupt id travels on the
  // route and is reattached at the graph service's adapter boundary.
  assert.deepEqual(buildHumanReviewResumeValue(decisions), { decisions });
});

test('human review interrupt resolves a single interaction as batch shape', () => {
  const route = reviewRoute(['review-1'], 'interrupt-1');
  const decisions = validateHumanReviewResponses(route, [{ interactionId: 'review-1', selectedOptionId: 'approve' }]);

  assert.deepEqual(buildHumanReviewResumeValue(decisions), {
    decisions: [{
      reviewId: 'review-1',
      selectedOptionId: 'approve',
    }],
  });
});

test('human review interrupt rejects decisions for mismatched interaction order', () => {
  const route = reviewRoute(['review-1', 'review-2']);

  assert.throws(() => validateHumanReviewResponses(route, [
      { interactionId: 'review-2', selectedOptionId: 'approve' },
      { interactionId: 'review-1', selectedOptionId: 'approve' },
    ]));
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
      type: 'interrupt.resume',
      requestId: 'req-1',
      interruptId: 'interrupt-1',
      value: { decisions: [{ interactionId: 'review-stale', selectedOptionId: 'approve' }] },
    },
    route,
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
    'interrupt_stale',
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
      type: 'interrupt.resume',
      requestId: 'req-1',
      interruptId: 'interrupt-1',
      value: { action: 'cancel' },
    },
    route,
    emitClosed: () => undefined,
    emitEvent: () => undefined,
    isConnected: () => true,
    run: async (_route, resume, source) => {
      runs.push({ resume, source });
      return 'interrupted';
    },
  });

  assert.deepEqual(buildHumanReviewCancelResumeValue(), { action: 'interrupt_run' });
  assert.deepEqual(runs, [{
    resume: { action: 'interrupt_run' },
    source: {
      type: 'review_cancel',
      interactionId: 'review-1',
      decisionCount: 0,
    },
  }]);
});

test('human review rejection resumes with a reject decision', async () => {
  const route = {
    ...reviewRoute(['review-1'], 'interrupt-1'),
    requestId: 'req-1',
  };
  const runs: unknown[] = [];

  await resolvePendingHumanReviewInterrupt({
    message: {
      type: 'interrupt.resume',
      requestId: 'req-1',
      interruptId: 'interrupt-1',
      value: { decisions: [{ interactionId: 'review-1', selectedOptionId: 'reject' }] },
    },
    route,
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
      decisions: [{ reviewId: 'review-1', selectedOptionId: 'reject' }],
    },
    source: {
      type: 'review_decision',
      interactionId: 'review-1',
      selectedOptionId: 'reject',
      decisionCount: 1,
    },
  }]);
});
