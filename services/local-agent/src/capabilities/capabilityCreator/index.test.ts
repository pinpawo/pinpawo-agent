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

test('capability_creator uses artifact toolkit for result persistence', async () => {
  const capability = createCapabilityCreatorCapability();
  const runtime = await capability.createRuntime({} as never);

  assert.deepEqual(runtime.uses, ['bash', 'capability_artifact']);
  assert.ok(Array.isArray(runtime.instructions));
  assert.ok(runtime.instructions.some((line) => line.includes('capability_artifact_write')));
  assert.equal(runtime.middleware?.afterRun, undefined);
});
