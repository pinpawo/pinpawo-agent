import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LocalServerStudioReviewRouter,
} from './localServerStudioReviews';
import type { ReviewSpec } from '@pinpawo/pet-agent';

function reviewSpec(): ReviewSpec {
  return {
    id: 'review-1',
    schemaVersion: 1,
    view: { kind: 'plain', body: 'Approve?' },
    options: [
      {
        id: 'approve',
        label: 'Approve',
        decision: { type: 'approve' },
      },
      {
        id: 'respond',
        label: 'Respond',
        input: {
          kind: 'text',
          key: 'message',
          required: true,
          multiline: true,
        },
        decision: { type: 'respond', messageInputKey: 'message' },
      },
    ],
  };
}

test('LocalServerStudioReviewRouter routes response only when a review is pending', async () => {
  const router = new LocalServerStudioReviewRouter<object>();
  const connection = {};

  assert.equal(router.routeResponse(connection, {
    type: 'human_review_response',
    requestId: 'req-1',
    reviewId: 'review-1',
    selectedOptionId: 'approve',
  }, () => undefined), false);

  const slot = router.getOrCreateSlot(connection);
  const responsePromise = new Promise((resolve, reject) => {
    slot.current = {
      petId: 'pet-1',
      reviewId: 'review-1',
      reviewSpec: reviewSpec(),
      resolve,
      reject,
    };
  });

  assert.equal(router.routeResponse(connection, {
    type: 'human_review_response',
    requestId: 'req-1',
    reviewId: 'review-1',
    selectedOptionId: 'respond',
    input: { message: '继续' },
  }, () => undefined), true);
  assert.deepEqual(await responsePromise, {
    reviewId: 'review-1',
    selectedOptionId: 'respond',
    input: { message: '继续' },
  });
  assert.equal(slot.current, null);
});

test('LocalServerStudioReviewRouter rejects non-canonical responses while review stays pending', async () => {
  const router = new LocalServerStudioReviewRouter<object>();
  const connection = {};
  const slot = router.getOrCreateSlot(connection);
  let resolved = false;
  slot.current = {
    petId: 'pet-1',
    reviewId: 'review-1',
    reviewSpec: reviewSpec(),
    resolve: () => {
      resolved = true;
    },
    reject: () => {},
  };

  assert.equal(router.routeResponse(connection, {
    type: 'human_review_response',
    requestId: 'req-1',
    message: '继续',
    resume: { decisions: [{ type: 'approve' }] },
  } as never, () => undefined), true);
  assert.equal(resolved, false);
  assert.notEqual(slot.current, null);
});

test('LocalServerStudioReviewRouter rejects and deletes disconnected slots', async () => {
  const router = new LocalServerStudioReviewRouter<object>();
  const connection = {};
  const slot = router.getOrCreateSlot(connection);
  const rejected = new Promise<unknown>((resolve) => {
    slot.current = {
      petId: 'pet-1',
      reviewId: 'review-1',
      reviewSpec: reviewSpec(),
      resolve,
      reject: (error) => resolve(error),
    };
  });

  assert.equal(router.rejectAndDelete(connection, new Error('ws disconnected')), true);
  const error = await rejected;
  assert.equal(error instanceof Error ? error.message : null, 'ws disconnected');
  assert.equal(router.routeResponse(connection, {
    type: 'human_review_response',
    requestId: 'req-1',
    reviewId: 'review-1',
    selectedOptionId: 'approve',
  }, () => undefined), false);
});
