import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapabilityCreatorCapability } from './index';

test('capability_creator relies on the shared subagent context window policy', () => {
  const capability = createCapabilityCreatorCapability();

  assert.equal('contextManagement' in capability, false);
  assert.equal('contextPolicy' in capability, false);
});

test('capability_creator keeps artifact persistence out of model tool calls', () => {
  const capability = createCapabilityCreatorCapability();

  // Still needs bash, but no longer relies on the model calling capability_artifact_write (issue #137).
  assert.deepEqual(capability.uses, ['bash', 'capability_creator']);
  assert.ok(!capability.instructions.content.includes('capability_artifact_write'));
  assert.equal(capability.lifecycle?.finalize, undefined);
});
