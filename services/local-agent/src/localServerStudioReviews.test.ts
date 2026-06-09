import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeStudioReviewDecision,
  LocalServerStudioReviewRouter,
} from './localServerStudioReviews';

test('decodeStudioReviewDecision prefers structured resume decisions', () => {
  assert.deepEqual(
    decodeStudioReviewDecision({
      message: 'ignored',
      resume: { decisions: [{ type: 'reject' }] },
    }),
    { type: 'reject' },
  );
});

test('decodeStudioReviewDecision maps local text conventions', () => {
  assert.deepEqual(decodeStudioReviewDecision({ message: '补充说明' }), {
    type: 'respond',
    message: '补充说明',
  });
  assert.deepEqual(decodeStudioReviewDecision({ message: '' }), { type: 'reject' });
});

test('decodeStudioReviewDecision treats structured approve resume as approve', () => {
  assert.deepEqual(
    decodeStudioReviewDecision({
      message: '批准执行',
      resume: { decisions: [{ type: 'approve' }] },
    }),
    { type: 'approve' },
  );
});

test('LocalServerStudioReviewRouter routes response only when a review is pending', async () => {
  const router = new LocalServerStudioReviewRouter<object>();
  const connection = {};

  assert.equal(router.routeResponse(connection, {
    type: 'human_review_response',
    requestId: 'req-1',
    message: 'hello',
  }, () => undefined), false);

  const slot = router.getOrCreateSlot(connection);
  const decisionPromise = new Promise((resolve, reject) => {
    slot.current = {
      petId: 'pet-1',
      reviewId: 'review-1',
      resolve,
      reject,
    };
  });

  assert.equal(router.routeResponse(connection, {
    type: 'human_review_response',
    requestId: 'req-1',
    message: '继续',
  }, () => undefined), true);
  assert.deepEqual(await decisionPromise, { type: 'respond', message: '继续' });
  assert.equal(slot.current, null);
});

test('LocalServerStudioReviewRouter rejects and deletes disconnected slots', async () => {
  const router = new LocalServerStudioReviewRouter<object>();
  const connection = {};
  const slot = router.getOrCreateSlot(connection);
  const rejected = new Promise<unknown>((resolve) => {
    slot.current = {
      petId: 'pet-1',
      reviewId: 'review-1',
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
    message: 'late',
  }, () => undefined), false);
});
