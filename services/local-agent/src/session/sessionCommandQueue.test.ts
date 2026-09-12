import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionCommandQueue } from './sessionCommandQueue';

test('session command queue preserves arrival order', async () => {
  const queue = new SessionCommandQueue();
  const seen: string[] = [];
  let releaseFirst: () => void = () => undefined;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.enqueue(async () => {
    seen.push('first:start');
    await firstBlocked;
    seen.push('first:end');
  });
  const second = queue.enqueue(async () => {
    seen.push('second');
  });
  const idle = queue.waitForIdle().then(() => {
    seen.push('idle');
  });

  await Promise.resolve();
  assert.deepEqual(seen, ['first:start'], 'the second command waits');
  releaseFirst();
  await Promise.all([first, second, idle]);
  assert.deepEqual(seen, ['first:start', 'first:end', 'second', 'idle']);
});

test('session command queue does not poison later commands after a failure', async () => {
  const queue = new SessionCommandQueue();
  const expected = new Error('failed');

  await assert.rejects(
    queue.enqueue(async () => {
      throw expected;
    }),
    expected,
  );
  // A failed command reaches its own caller but must not block the queue.
  await queue.enqueue(async () => undefined);
  await queue.waitForIdle();
});

test('a human message waits for queued commands to drain', async () => {
  // The ordering that matters in practice: /compact is still running when a
  // message is sent, so the message must not start against the old context.
  const queue = new SessionCommandQueue();
  const seen: string[] = [];
  let releaseCompact: () => void = () => undefined;
  const compacting = new Promise<void>((resolve) => {
    releaseCompact = resolve;
  });

  const compact = queue.enqueue(async () => {
    seen.push('compact:start');
    await compacting;
    seen.push('compact:end');
  });
  const message = queue.waitForIdle().then(() => {
    seen.push('message');
  });

  releaseCompact();
  await Promise.all([compact, message]);
  assert.deepEqual(seen, ['compact:start', 'compact:end', 'message']);
});
