import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateReconnectDelay } from './reconnect.js';

test('extension reconnect backoff grows exponentially within a bounded jitter range', () => {
  assert.equal(calculateReconnectDelay(0, 1_000, 30_000, () => 0), 500);
  assert.equal(calculateReconnectDelay(1, 1_000, 30_000, () => 0.5), 1_500);
  assert.equal(calculateReconnectDelay(10, 1_000, 30_000, () => 1), 30_000);
});
