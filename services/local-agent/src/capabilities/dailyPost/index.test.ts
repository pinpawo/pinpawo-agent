import assert from 'node:assert/strict';
import test from 'node:test';
import { createDailyPostCapability } from './index';

test('daily_post persists its result deterministically via afterRun, not a model-driven write tool', async () => {
  const capability = createDailyPostCapability({
    savePost: async () => ({ postId: 'post-1' }),
  });
  const runtime = await capability.createRuntime({} as never);

  // No longer relies on the model calling capability_artifact_write (issue #137).
  assert.ok(!(runtime.uses ?? []).includes('capability_artifact'));
  assert.ok(Array.isArray(runtime.instructions));
  assert.ok(!runtime.instructions.some((line) => line.includes('capability_artifact_write')));
  assert.equal(typeof runtime.middleware?.afterRun, 'function');
});
