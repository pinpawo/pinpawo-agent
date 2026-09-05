import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAgentSessionSnapshot,
  readHumanReviewPendingInterrupt,
} from '@pinpawo/agent-session';
import { TuiSessionController } from './sessionController';
import {
  FakeConnection,
  reviewSnapshotResult,
  reviewSpec,
} from './sessionControllerTestSupport';

test('review responses advance approved batches and send the final canonical responses', () => {
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
    interruptId: 'review-action',
    responses: [],
    optionId: 'approve-1',
  });
  assert.equal(first.ok, true);
  assert.equal(first.ok ? first.status : null, 'advanced');
  assert.equal(connection.sent.length, 1);

  const second = controller.submitReviewResponse({
    interruptId: 'review-action',
    responses: first.ok ? first.responses : [],
    optionId: 'approve-2',
  });
  assert.equal(second.ok, true);
  assert.equal(second.ok ? second.status : null, 'sent');
  assert.deepEqual(connection.sent.at(-1), {
    type: 'human_review_response',
    requestId: 'startup',
    interruptId: 'review-action',
    responses: [{
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
    interruptId: 'review-action',
    responses: [],
    optionId: 'respond',
    inputText: '   ',
  }), {
    ok: false,
    reason: 'input-required',
  });
  assert.deepEqual(controller.submitReviewResponse({
    interruptId: 'review-action',
    responses: [{
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
    interruptId: 'review-action',
    responses: [],
    optionId: 'respond',
    inputText: '  needs changes  ',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(connection.sent.at(-1), {
    type: 'human_review_response',
    requestId: 'startup',
    interruptId: 'review-action',
    responses: [{
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
    interruptId: 'other-interrupt',
  }), {
    ok: false,
    reason: 'stale',
  });
  assert.deepEqual(controller.cancelReview({
    interruptId: 'review-action',
  }), {
    ok: true,
  });
  assert.deepEqual(connection.sent.at(-1), {
    type: 'review.cancel',
    requestId: 'startup',
    interruptId: 'review-action',
  });
  controller.stop();
});

test('authoritative completion snapshot closes a review rejected by the server', () => {
  const requestIds = ['startup', 'resume', 'completion'];
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => requestIds.shift() ?? 'unexpected',
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

  assert.equal(controller.submitReviewResponse({
    interruptId: 'review-action',
    responses: [],
    optionId: 'approve',
  }).ok, true);
  connection.receive({
    type: 'event',
    requestId: 'resume',
    event: {
      type: 'error',
      requestId: 'resume',
      message: 'review closed',
      code: 'review_closed',
    },
  });
  assert.equal(
    readHumanReviewPendingInterrupt(
      controller.getState().session.pendingInterrupt,
    )?.interruptId,
    'review-action',
  );
  assert.deepEqual(connection.sent.at(-1), {
    type: 'session.snapshot.get',
    requestId: 'completion',
  });

  connection.receive({
    type: 'session.snapshot.result',
    requestId: 'completion',
    snapshot: createAgentSessionSnapshot({
      sessionId: 'chat:one',
      kind: 'chat',
      timeline: [],
      activeRun: null,
      pendingInterrupt: null,
    }),
  });

  assert.equal(controller.getState().session.pendingInterrupt, null);
  assert.equal(controller.getState().session.activeRun, null);
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
    interruptId: 'other-interrupt',
  }), {
    ok: false,
    reason: 'stale',
  });
  controller.submitReviewResponse({
    interruptId: 'review-action',
    responses: [],
    optionId: 'approve',
  });
  assert.deepEqual(controller.interruptResolvedReview({
    interruptId: 'review-action',
  }), {
    ok: true,
    requestId: 'startup',
  });
  assert.deepEqual(connection.sent.at(-1), {
    type: 'run.interrupt',
    requestId: 'startup',
  });
  assert.equal(controller.getState().session.activeRun?.state, 'interrupting');
  assert.equal(
    readHumanReviewPendingInterrupt(
      controller.getState().session.pendingInterrupt,
    )?.interruptId,
    'review-action',
  );
  controller.stop();
});
