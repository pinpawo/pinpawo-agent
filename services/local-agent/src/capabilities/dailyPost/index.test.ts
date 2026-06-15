import assert from 'node:assert/strict';
import test from 'node:test';
import { createDailyPostCapability } from './index';

test('daily_post uses artifact toolkit for result persistence', async () => {
  const capability = createDailyPostCapability({
    savePost: async () => ({ postId: 'post-1' }),
  });
  const runtime = await capability.createRuntime({} as never);

  assert.deepEqual(runtime.uses, ['capability_artifact']);
  assert.ok(Array.isArray(runtime.instructions));
  assert.ok(runtime.instructions.some((line) => line.includes('capability_artifact_write')));
  assert.equal(runtime.middleware?.afterRun, undefined);
});
