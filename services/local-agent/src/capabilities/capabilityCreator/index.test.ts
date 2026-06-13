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
