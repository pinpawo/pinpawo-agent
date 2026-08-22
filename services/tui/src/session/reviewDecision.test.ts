import assert from 'node:assert/strict';
import test from 'node:test';
import type { PendingInterruptProjection } from '@pinpawo/agent-session';
import { prepareReviewDecision } from './reviewDecision';

test('approved review batches advance without sending until the final review', () => {
  const pendingInterrupt = reviewAction();
  const first = prepareReviewDecision({
    pendingInterrupt,
    responses: [],
    optionId: 'approve',
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.shouldSend, false);

  const second = prepareReviewDecision({
    pendingInterrupt,
    responses: first.responses,
    optionId: 'approve',
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.shouldSend, true);
});

test('review decision preparation validates required input and stale drafts', () => {
  const pendingInterrupt = reviewAction();
  assert.deepEqual(prepareReviewDecision({
    pendingInterrupt,
    responses: [],
    optionId: 'comment',
  }), {
    ok: false,
    reason: 'input-required',
  });
  assert.deepEqual(prepareReviewDecision({
    pendingInterrupt,
    responses: [{
      interactionId: 'wrong-review',
      selectedOptionId: 'approve',
    }],
    optionId: 'approve',
  }), {
    ok: false,
    reason: 'stale',
  });
});

function reviewAction(): PendingInterruptProjection {
  return {
    interruptId: 'review-pendingInterrupt',
    payload: {
      kind: 'human_review',
      interactions: ['review-1', 'review-2'].map((id) => ({
        interactionId: id,
        schemaVersion: 2 as const,
        view: {
          kind: 'plain',
          body: `Review ${id}`,
        },
        options: [{
          id: 'approve',
          label: 'Approve',
          batchSubmission: 'defer',
        }, {
          id: 'comment',
          label: 'Comment',
          batchSubmission: 'immediate',
          input: {
            kind: 'text',
            key: 'message',
            label: 'Comment',
          },
        }],
      })),
    },
  };
}
