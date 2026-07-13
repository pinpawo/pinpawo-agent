import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapabilityCreatorCapability } from './index';

test('capability_creator declares read-heavy context management overrides', async () => {
  const capability = createCapabilityCreatorCapability();
  const runtime = await capability.createRuntime({} as never);

  assert.deepEqual(runtime.contextManagement?.evictToolResults, {
    keepRecent: 5,
    keepFailures: true,
  });
});

test('capability_creator keeps artifact persistence out of model tool calls', async () => {
  const capability = createCapabilityCreatorCapability();
  const runtime = await capability.createRuntime({} as never);

  // Still needs bash, but no longer relies on the model calling capability_artifact_write (issue #137).
  assert.deepEqual(runtime.uses, ['bash']);
  assert.ok(Array.isArray(runtime.instructions));
  assert.ok(!runtime.instructions.some((line) => line.includes('capability_artifact_write')));
  assert.equal(runtime.middleware?.afterRun, undefined);
});
