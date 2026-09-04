import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isHumanReviewCancelResume,
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

test('human review cancellation accepts the canonical action and migration alias', () => {
  assert.equal(isHumanReviewCancelResume({ action: 'cancel' }), true);
  assert.equal(isHumanReviewCancelResume({ action: 'interrupt_run' }), true);
  assert.equal(isHumanReviewCancelResume({ action: 'interrupt_run', decisions: [] }), false);
  assert.equal(isHumanReviewCancelResume({ action: 'reject' }), false);
  assert.equal(isHumanReviewCancelResume(null), false);
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
