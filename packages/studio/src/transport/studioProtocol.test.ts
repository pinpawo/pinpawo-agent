import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStudioClientMessage } from './studioProtocol';
import { parseStudioDispatchRequest } from '../studioInvocation';

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

test('Studio protocol parses an opaque continuation resume and rejects invalid envelopes', () => {
  assert.ok(parseStudioClientMessage({
    type: 'studio.dispatch',
    deliveryId: 'delivery-1',
    petId: 'writer',
    input: {
      kind: 'resume',
      continuationId: 'continuation-1',
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
      kind: 'resume',
      continuationId: '',
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

test('transport-neutral dispatch parsing does not require a wire delivery envelope', () => {
  assert.deepEqual(parseStudioDispatchRequest({
    petId: 'pet-a',
    input: { kind: 'request', request: 'hello' },
    metadata: { producer: 'http' },
    idempotencyKey: 'retry-1',
  }), {
    petId: 'pet-a',
    input: { kind: 'request', request: 'hello' },
    metadata: { producer: 'http' },
    idempotencyKey: 'retry-1',
  });
  assert.equal(parseStudioDispatchRequest({
    petId: 'pet-a',
    input: { kind: 'request', request: 'hello' },
    deliveryId: 'wire-only',
  }), null);
});
