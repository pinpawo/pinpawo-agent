import assert from 'node:assert/strict';
import test from 'node:test';
import { createDailyPostCapability } from './index';

test('daily_post keeps artifact persistence out of model-driven write tools', () => {
  const capability = createDailyPostCapability();

  // No longer relies on the model calling capability_artifact_write (issue #137).
  assert.deepEqual(capability.uses, ['daily_post']);
  assert.ok(!capability.instructions.content.includes('capability_artifact_write'));
  assert.equal(capability.lifecycle?.finalize, undefined);
});
