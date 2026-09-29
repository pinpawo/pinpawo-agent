import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { buildRuntimeEnvironmentSummary } from './runtimeEnvironment';

test('environment summary reflects invocation session facts without capturing a previous session', () => {
  const sessionStartedAt = randomUUID();
  const timezone = randomUUID();
  const first = buildRuntimeEnvironmentSummary({ sessionStartedAt, timezone });
  assert.ok(first.includes(sessionStartedAt));
  assert.ok(first.includes(timezone));
  const second = buildRuntimeEnvironmentSummary();
  assert.equal(second.includes(sessionStartedAt), false);
  assert.equal(second.includes(timezone), false);
});
