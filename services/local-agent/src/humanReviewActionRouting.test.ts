import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewSpec } from '@pinpawo/pet-agent';
import {
  buildHumanReviewRejectResume,
  buildHumanReviewResume,
  validateHumanReviewDecisions,
} from './humanReviewActionRouting';

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
    status: 'waiting' as const,
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
