import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isHumanReviewCancelResume,
  resolveHumanReviewBatchResume,
  resolveHumanReviewBatchResponse,
  ReviewResponseResolutionError,
} from './reviewResponseResolver';
import { isValidHumanReviewResume } from './reviewResponseSchema';
import type { ReviewResolutionContext, ReviewBatchResponse, ReviewSpec } from '../../../types/reviewSpec';

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

test('review resume schemas reject malformed canonical responses and normalize identifiers', () => {
  for (const response of [
    null,
    [],
    { decisions: [] },
    { decisions: [{ reviewId: '', selectedOptionId: 'approve' }] },
    { decisions: [{ reviewId: 'review-1', selectedOptionId: '   ' }] },
    { decisions: [{ reviewId: 'review-1', selectedOptionId: 'approve', extra: true }] },
    { decisions: [{ reviewId: 'review-1', selectedOptionId: 'approve', input: [] }] },
    { decisions: [{ reviewId: 'review-1', selectedOptionId: 'approve' }], extra: true },
    { action: 'reject' },
    { action: 'cancel', decisions: [] },
  ]) {
    assert.equal(isValidHumanReviewResume(response), false, JSON.stringify(response));
  }
  const resolutions = resolveHumanReviewBatchResume([{ reviewSpec: reviewSpec('review-1') }], {
    decisions: [{ reviewId: ' review-1 ', selectedOptionId: ' approve ' }],
  });
  assert.equal(resolutions[0]?.decision.type, 'approve');
  assert.equal(resolutions[0]?.reviewId, 'review-1');
});

test('well-shaped review responses still require the declared option and input policy', () => {
  const pendingReviews = [{ reviewSpec: reviewSpec('review-1') }];
  for (const { response, code } of [
    { response: { reviewId: 'stale', selectedOptionId: 'approve' }, code: 'stale_review' },
    { response: { reviewId: 'review-1', selectedOptionId: 'other' }, code: 'unknown_option' },
    { response: { reviewId: 'review-1', selectedOptionId: 'approve', input: { message: 'extra' } }, code: 'unexpected_input' },
  ]) {
    const resume = { decisions: [response] };
    assert.equal(isValidHumanReviewResume(resume), true);
    assert.throws(() => resolveHumanReviewBatchResume(pendingReviews, resume),
      (error) => error instanceof ReviewResponseResolutionError && error.code === code);
  }
});
