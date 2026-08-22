import assert from 'node:assert/strict';
import test from 'node:test';
import { TuiSessionController } from './sessionController';
import {
  FakeConnection,
  reviewSnapshotResult,
  reviewSpec,
} from './sessionControllerTestSupport';

test('review responses advance approved batches and send the final canonical decisions', () => {
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => 'startup',
  });
  controller.start();
  connection.open();
  connection.receive(reviewSnapshotResult('startup', [
    reviewSpec('review-1', [{
      id: 'approve-1',
      label: 'Approve first',
      batchSubmission: 'defer',
    }]),
    reviewSpec('review-2', [{
      id: 'approve-2',
      label: 'Approve second',
      batchSubmission: 'defer',
    }]),
  ]));

  const first = controller.submitReviewResponse({
    requestId: 'chat',
    interruptId: 'review-action',
    decisions: [],
    optionId: 'approve-1',
  });
  assert.equal(first.ok, true);
  assert.equal(first.ok ? first.status : null, 'advanced');
  assert.equal(connection.sent.length, 1);

  const second = controller.submitReviewResponse({
    requestId: 'chat',
    interruptId: 'review-action',
    decisions: first.ok ? first.decisions : [],
    optionId: 'approve-2',
  });
  assert.equal(second.ok, true);
  assert.equal(second.ok ? second.status : null, 'sent');
  assert.deepEqual(connection.sent.at(-1), {
    type: 'human_review_response',
    requestId: 'chat',
    interruptId: 'review-action',
    interactionId: 'review-2',
    selectedOptionId: 'approve-2',
    decisions: [{
      interactionId: 'review-1',
      selectedOptionId: 'approve-1',
    }, {
      interactionId: 'review-2',
      selectedOptionId: 'approve-2',
    }],
  });
  controller.stop();
});

test('review responses validate free text and reject stale local drafts', () => {
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => 'startup',
  });
  controller.start();
  connection.open();
  connection.receive(reviewSnapshotResult('startup', [
    reviewSpec('review-1', [{
      id: 'respond',
      label: 'Respond',
      input: {
        kind: 'text',
        key: 'message',
        required: true,
        multiline: true,
      },
      batchSubmission: 'immediate',
    }]),
  ]));

  assert.deepEqual(controller.submitReviewResponse({
    requestId: 'chat',
    interruptId: 'review-action',
    decisions: [],
    optionId: 'respond',
    inputText: '   ',
  }), {
    ok: false,
    reason: 'input-required',
  });
  assert.deepEqual(controller.submitReviewResponse({
    requestId: 'chat',
    interruptId: 'review-action',
    decisions: [{
      interactionId: 'wrong-review',
      selectedOptionId: 'respond',
    }],
    optionId: 'respond',
    inputText: 'ship it',
  }), {
    ok: false,
    reason: 'stale',
  });

  const result = controller.submitReviewResponse({
    requestId: 'chat',
    interruptId: 'review-action',
    decisions: [],
    optionId: 'respond',
    inputText: '  needs changes  ',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(connection.sent.at(-1), {
    type: 'human_review_response',
    requestId: 'chat',
    interruptId: 'review-action',
    interactionId: 'review-1',
    selectedOptionId: 'respond',
    input: { message: 'needs changes' },
    decisions: [{
      interactionId: 'review-1',
      selectedOptionId: 'respond',
      input: { message: 'needs changes' },
    }],
  });
  controller.stop();
});

test('review cancellation targets only the current pending interrupt', () => {
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => 'startup',
  });
  controller.start();
  connection.open();
  connection.receive(reviewSnapshotResult('startup', [
    reviewSpec('review-1', [{
      id: 'approve',
      label: 'Approve',
      batchSubmission: 'immediate',
    }]),
  ]));

  assert.deepEqual(controller.cancelReview({
    requestId: 'other',
    interruptId: 'review-action',
  }), {
    ok: false,
    reason: 'stale',
  });
  assert.deepEqual(controller.cancelReview({
    requestId: 'chat',
    interruptId: 'review-action',
  }), {
    ok: true,
  });
  assert.deepEqual(connection.sent.at(-1), {
    type: 'review.cancel',
    requestId: 'chat',
    interruptId: 'review-action',
  });
  controller.stop();
});

test('a sent review resolution can be followed by an ordered run interrupt', () => {
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => 'startup',
  });
  controller.start();
  connection.open();
  connection.receive(reviewSnapshotResult('startup', [
    reviewSpec('review-1', [{
      id: 'approve',
      label: 'Approve',
      batchSubmission: 'immediate',
    }]),
  ]));

  assert.deepEqual(controller.interruptResolvedReview({
    requestId: 'other',
    interruptId: 'review-action',
  }), {
    ok: false,
    reason: 'stale',
  });
  assert.deepEqual(controller.interruptResolvedReview({
    requestId: 'chat',
    interruptId: 'review-action',
  }), {
    ok: true,
    requestId: 'chat',
  });
  assert.deepEqual(connection.sent.at(-1), {
    type: 'run.interrupt',
    requestId: 'chat',
  });
  assert.equal(
    controller.getState().session.activeRun?.state,
    'pending_interrupt',
  );
  controller.stop();
});
