import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapabilityCreatorCapability } from './index';

test('capability_creator relies on the shared subagent context window policy', async () => {
  const capability = createCapabilityCreatorCapability();
  const runtime = await capability.createRuntime({} as never);

  assert.equal('contextManagement' in runtime, false);
  assert.equal('contextPolicy' in runtime, false);
});

test('capability_creator keeps artifact persistence out of model tool calls', async () => {
  const capability = createCapabilityCreatorCapability();
  const runtime = await capability.createRuntime({} as never);

  // Still needs bash, but no longer relies on the model calling capability_artifact_write (issue #137).
  assert.deepEqual(capability.uses, ['bash', 'capability_creator']);
  assert.ok(Array.isArray(runtime.instructions));
  assert.ok(!runtime.instructions.some((line) => line.includes('capability_artifact_write')));
  assert.equal(runtime.middleware?.afterRun, undefined);
});
