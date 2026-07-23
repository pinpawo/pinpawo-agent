import assert from 'node:assert/strict';
import test from 'node:test';
import { createDailyPostCapability } from './index';

test('daily_post keeps artifact persistence out of model-driven write tools', async () => {
  const capability = createDailyPostCapability();
  const runtime = await capability.createRuntime({} as never);

  // No longer relies on the model calling capability_artifact_write (issue #137).
  assert.deepEqual(capability.uses, ['daily_post']);
  assert.ok(Array.isArray(runtime.instructions));
  assert.ok(!runtime.instructions.some((line) => line.includes('capability_artifact_write')));
  assert.equal(runtime.middleware?.afterRun, undefined);
});
