import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapabilityCreatorCapability } from './index';

test('capability_creator declares read-heavy context policy', async () => {
  const capability = createCapabilityCreatorCapability();
  const runtime = await capability.createRuntime({} as never);

  assert.deepEqual(runtime.contextPolicy?.evictToolResults, {
    keepRecent: 5,
    budgetTokens: 24_000,
    keepFailures: true,
  });
});

test('capability_creator persists its result deterministically via afterRun, not a model-driven write tool', async () => {
  const capability = createCapabilityCreatorCapability();
  const runtime = await capability.createRuntime({} as never);

  // Still needs bash, but no longer relies on the model calling capability_artifact_write (issue #137).
  assert.deepEqual(runtime.uses, ['bash']);
  assert.ok(Array.isArray(runtime.instructions));
  assert.ok(!runtime.instructions.some((line) => line.includes('capability_artifact_write')));
  assert.equal(typeof runtime.middleware?.afterRun, 'function');
});
