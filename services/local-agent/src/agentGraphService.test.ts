import assert from 'node:assert/strict';
import test from 'node:test';
import { readHasResumableDelegation } from './agentGraphService';

test('readHasResumableDelegation follows the checkpoint taskActiveDelegation', () => {
  assert.equal(readHasResumableDelegation(null), false);
  assert.equal(readHasResumableDelegation({ values: {} }), false);
  assert.equal(readHasResumableDelegation({
    values: { taskActiveDelegation: null },
  }), false);
  assert.equal(readHasResumableDelegation({
    values: {
      taskActiveDelegation: {
        id: 'delegation-1',
        status: 'awaiting_decision',
      },
    },
  }), true);
});
