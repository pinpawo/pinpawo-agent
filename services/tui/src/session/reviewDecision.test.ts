import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentReviewAction } from '@pinpawo/agent-session';
import { prepareReviewDecision } from './reviewDecision';

test('approved review batches advance without sending until the final review', () => {
  const action = reviewAction();
  const first = prepareReviewDecision({
    action,
    decisions: [],
    optionId: 'approve',
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.shouldSend, false);

  const second = prepareReviewDecision({
    action,
    decisions: first.decisions,
    optionId: 'approve',
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.shouldSend, true);
});

test('review decision preparation validates required input and stale drafts', () => {
  const action = reviewAction();
  assert.deepEqual(prepareReviewDecision({
    action,
    decisions: [],
    optionId: 'comment',
  }), {
    ok: false,
    reason: 'input-required',
  });
  assert.deepEqual(prepareReviewDecision({
    action,
    decisions: [{
      reviewId: 'wrong-review',
      selectedOptionId: 'approve',
    }],
    optionId: 'approve',
  }), {
    ok: false,
    reason: 'stale',
  });
});

function reviewAction(): AgentReviewAction {
  return {
    actionId: 'review-action',
    reviews: ['review-1', 'review-2'].map((id) => ({
      id,
      schemaVersion: 1,
      view: {
        kind: 'plain',
        body: `Review ${id}`,
      },
      options: [{
        id: 'approve',
        label: 'Approve',
        decision: { type: 'approve' },
      }, {
        id: 'comment',
        label: 'Comment',
        decision: { type: 'reject' },
        input: {
          kind: 'text',
          key: 'message',
          label: 'Comment',
        },
      }],
    })),
  };
}
