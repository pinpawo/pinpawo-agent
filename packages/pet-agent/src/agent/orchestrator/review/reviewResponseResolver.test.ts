import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isHumanReviewRunControlResume,
  resolveHumanReviewBatchResponse,
  ReviewResponseResolutionError,
} from './reviewResponseResolver';
import type { ReviewResolutionContext, ReviewBatchResponse, ReviewSpec } from './reviewSpec';

function reviewSpec(id: string): ReviewSpec {
  return {
    id,
    schemaVersion: 1,
    view: { kind: 'plain', body: `review ${id}` },
    options: [
      {
        id: 'approve',
        label: 'Approve',
        decision: { type: 'approve' },
      },
      {
        id: 'reject',
        label: 'Reject',
        decision: { type: 'reject', message: 'nope' },
      },
    ],
  };
}

test('human review run control accepts only the canonical interrupt shape', () => {
  assert.equal(isHumanReviewRunControlResume({ action: 'interrupt_run' }), true);
  assert.equal(isHumanReviewRunControlResume({ action: 'interrupt_run', decisions: [] }), false);
  assert.equal(isHumanReviewRunControlResume({ action: 'reject' }), false);
  assert.equal(isHumanReviewRunControlResume(null), false);
});

test('resolveHumanReviewBatchResponse maps decisions to matching pending reviews', () => {
  const pendingReviews: ReviewResolutionContext[] = [
    { reviewSpec: reviewSpec('review-1') },
    { reviewSpec: reviewSpec('review-2') },
  ];
  const response: ReviewBatchResponse = {
    decisions: [
      { reviewId: 'review-1', selectedOptionId: 'approve' },
      { reviewId: 'review-2', selectedOptionId: 'reject' },
    ],
  };

  const resolutions = resolveHumanReviewBatchResponse(pendingReviews, response);

  assert.deepEqual(
    resolutions.map((resolution) => resolution.reviewId),
    ['review-1', 'review-2'],
  );
});

test('resolveHumanReviewBatchResponse rejects mismatched decision order', () => {
  const pendingReviews: ReviewResolutionContext[] = [
    { reviewSpec: reviewSpec('review-1') },
    { reviewSpec: reviewSpec('review-2') },
  ];
  const response: ReviewBatchResponse = {
    decisions: [
      { reviewId: 'review-2', selectedOptionId: 'approve' },
      { reviewId: 'review-1', selectedOptionId: 'approve' },
    ],
  };

  assert.throws(
    () => resolveHumanReviewBatchResponse(pendingReviews, response),
    (error) => error instanceof ReviewResponseResolutionError && error.code === 'stale_review',
  );
});
