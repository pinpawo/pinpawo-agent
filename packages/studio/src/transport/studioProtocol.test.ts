import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStudioClientMessage } from './studioProtocol';

test('Studio protocol parses a typed request dispatch', () => {
  assert.deepEqual(parseStudioClientMessage(JSON.stringify({
    type: 'studio.dispatch',
    deliveryId: 'delivery-1',
    petId: 'writer',
    input: { kind: 'request', request: 'write it' },
    metadata: { taskId: 'task-1' },
    idempotencyKey: 'task-1',
  })), {
    type: 'studio.dispatch',
    deliveryId: 'delivery-1',
    petId: 'writer',
    input: { kind: 'request', request: 'write it' },
    metadata: { taskId: 'task-1' },
    idempotencyKey: 'task-1',
  });
});

test('Studio protocol parses review resume and rejects invalid payloads', () => {
  assert.ok(parseStudioClientMessage({
    type: 'studio.dispatch',
    deliveryId: 'delivery-1',
    petId: 'writer',
    input: {
      kind: 'resume_interrupt',
      interruptId: 'interrupt-1',
      payload: {
        kind: 'human_review_response',
        responses: [{ interactionId: 'review-1', selectedOptionId: 'approve' }],
      },
    },
  }));
  assert.equal(parseStudioClientMessage({
    type: 'studio.dispatch',
    deliveryId: 'delivery-1',
    petId: 'writer',
    input: {
      kind: 'resume_interrupt',
      interruptId: 'interrupt-1',
      payload: { kind: 'human_review_response', responses: [] },
    },
  }), null);
});

test('Studio protocol does not accept the historical Chat studio_request shape', () => {
  assert.equal(parseStudioClientMessage({
    type: 'studio_request',
    requestId: 'request-1',
    userRequest: 'go',
  }), null);
});
