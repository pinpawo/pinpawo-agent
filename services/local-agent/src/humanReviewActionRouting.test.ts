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

test('human review action routing resumes once for a rejected first decision', () => {
  const route = {
    interruptId: 'interrupt-1',
    reviewId: 'review-1',
    resumeMode: 'review_action' as const,
    reviews: [reviewSpec('review-1'), reviewSpec('review-2')],
  };

  assert.deepEqual(buildHumanReviewRejectResume(route, 'reject'), {
    'interrupt-1': {
      decisions: [
        { reviewId: 'review-1', selectedOptionId: 'reject' },
      ],
    },
  });
});

test('human review action routing rejects partial approval resumes', () => {
  const route = {
    reviewId: 'review-1',
    resumeMode: 'review_action' as const,
    reviews: [reviewSpec('review-1'), reviewSpec('review-2')],
  };

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
  const route = {
    interruptId: 'interrupt-1',
    reviewId: 'review-1',
    resumeMode: 'review_action' as const,
    reviews: [reviewSpec('review-1'), reviewSpec('review-2')],
  };
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

test('human review action routing preserves legacy single-review resume shape', () => {
  const route = {
    interruptId: 'interrupt-1',
    reviewId: 'review-1',
    resumeMode: 'legacy_review' as const,
    reviews: [reviewSpec('review-1')],
  };
  const decisions = validateHumanReviewDecisions(route, {
    type: 'human_review_response',
    requestId: 'req-1',
    reviewId: 'review-1',
    selectedOptionId: 'approve',
  });

  assert.deepEqual(buildHumanReviewResume(route, decisions), {
    'interrupt-1': {
      reviewId: 'review-1',
      selectedOptionId: 'approve',
    },
  });
});
