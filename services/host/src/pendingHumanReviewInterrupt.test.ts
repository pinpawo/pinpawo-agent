import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewSpec } from '@pinpawo/pet-agent';
import {
  buildHumanReviewCancelResumeValue,
  buildHumanReviewResumeValue,
  resolveHumanReviewAnswer,
  validateHumanReviewResponses,
} from './pendingHumanReviewInterrupt';

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

test('human review interrupt rejects partial approval resumes', () => {
  const reviews = ['review-1', 'review-2'].map(reviewSpec);

  assert.deepEqual(resolveHumanReviewAnswer(reviews, {
    decisions: [{ interactionId: 'review-1', selectedOptionId: 'approve' }],
  }), { code: 'interrupt_response_invalid' });
});

test('human review interrupt resumes complete approvals as one payload', () => {
  const reviews = ['review-1', 'review-2'].map(reviewSpec);
  const decisions = validateHumanReviewResponses(reviews, [
      { interactionId: 'review-1', selectedOptionId: 'approve' },
      { interactionId: 'review-2', selectedOptionId: 'approve' },
    ]);

  // The value carries the decisions only; the interrupt id travels on the
  // request and is reattached at the graph service's adapter boundary.
  assert.deepEqual(buildHumanReviewResumeValue(decisions), { decisions });
});

test('human review interrupt resolves a single interaction as batch shape', () => {
  const reviews = ['review-1'].map(reviewSpec);
  const decisions = validateHumanReviewResponses(reviews, [{ interactionId: 'review-1', selectedOptionId: 'approve' }]);

  assert.deepEqual(buildHumanReviewResumeValue(decisions), {
    decisions: [{
      reviewId: 'review-1',
      selectedOptionId: 'approve',
    }],
  });
});

test('human review interrupt rejects decisions for mismatched interaction order', () => {
  const reviews = ['review-1', 'review-2'].map(reviewSpec);

  assert.throws(() => validateHumanReviewResponses(reviews, [
      { interactionId: 'review-2', selectedOptionId: 'approve' },
      { interactionId: 'review-1', selectedOptionId: 'approve' },
    ]));
});

test('a stale decision cannot produce a resume', () => {
  assert.deepEqual(resolveHumanReviewAnswer([reviewSpec('review-1')], {
    decisions: [{ interactionId: 'review-stale', selectedOptionId: 'approve' }],
  }), { code: 'interrupt_stale' });
});

test('human review cancellation does not fabricate a decision', () => {
  assert.deepEqual(buildHumanReviewCancelResumeValue(), { action: 'interrupt_run' });
  assert.deepEqual(resolveHumanReviewAnswer([reviewSpec('review-1')], { action: 'cancel' }), {
    resume: { action: 'interrupt_run' },
    source: { type: 'review_cancel', interactionId: 'review-1', decisionCount: 0 },
  });
});

test('human review rejection preserves the chosen option', () => {
  assert.deepEqual(resolveHumanReviewAnswer([reviewSpec('review-1')], {
    decisions: [{ interactionId: 'review-1', selectedOptionId: 'reject' }],
  }), {
    resume: { decisions: [{ reviewId: 'review-1', selectedOptionId: 'reject' }] },
    source: { type: 'review_decision', interactionId: 'review-1', selectedOptionId: 'reject', decisionCount: 1 },
  });
});
