import assert from 'node:assert/strict';
import test from 'node:test';
import { withRendererSuspended } from './rendererLifecycle';

test('renderer resumes after a suspended operation succeeds or fails', async () => {
  const lifecycle: string[] = [];
  const renderer = {
    suspend: () => lifecycle.push('suspend'),
    resume: () => lifecycle.push('resume'),
  };
  assert.equal(await withRendererSuspended(
    renderer,
    async () => {
      lifecycle.push('operation');
      return 'done';
    },
  ), 'done');
  assert.deepEqual(lifecycle, ['suspend', 'operation', 'resume']);

  lifecycle.length = 0;
  await assert.rejects(
    () => withRendererSuspended(renderer, async () => {
      lifecycle.push('operation');
      throw new Error('operation failed');
    }),
    /operation failed/,
  );
  assert.deepEqual(lifecycle, ['suspend', 'operation', 'resume']);
});
