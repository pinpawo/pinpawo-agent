import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildStudioRunIdentity } from './types';

test('buildStudioRunIdentity derives conversationId from runId when missing', () => {
  const identity = buildStudioRunIdentity({ runId: 'run-123' });

  assert.equal(identity.runId, 'run-123');
  assert.equal(identity.conversationId, 'run-123');
  assert.equal(identity.idempotencyKey, 'studio:run-123:run:run-123');
});

test('buildStudioRunIdentity keeps explicit conversationId and formats stable key', () => {
  const identity = buildStudioRunIdentity({
    runId: 'run-123',
    conversationId: 'conv-456',
  });

  assert.equal(identity.runId, 'run-123');
  assert.equal(identity.conversationId, 'conv-456');
  assert.equal(identity.idempotencyKey, 'studio:conv-456:run:run-123');
});
