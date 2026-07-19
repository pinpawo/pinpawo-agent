import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalAgentServerMessage } from './localAgentProtocol';
import type { LocalServerPeer } from './localServerPeer';
import { LocalServerSessionCommandQueue } from './localServerSessionCommandQueue';

function createPeer(): LocalServerPeer {
  return {
    isConnected: () => true,
    send: (_message: LocalAgentServerMessage) => true,
  };
}

test('session command queue preserves peer-local arrival order', async () => {
  const queue = new LocalServerSessionCommandQueue();
  const peer = createPeer();
  const seen: string[] = [];
  let releaseFirst: () => void = () => undefined;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.enqueue(peer, async () => {
    seen.push('first:start');
    await firstBlocked;
    seen.push('first:end');
  });
  const second = queue.enqueue(peer, async () => {
    seen.push('second');
  });
  const idle = queue.waitForIdle(peer).then(() => {
    seen.push('idle');
  });

  await Promise.resolve();
  assert.deepEqual(seen, ['first:start']);
  releaseFirst();
  await Promise.all([first, second, idle]);
  assert.deepEqual(seen, ['first:start', 'first:end', 'second', 'idle']);
});

test('session command queue does not poison later commands after a failure', async () => {
  const queue = new LocalServerSessionCommandQueue();
  const peer = createPeer();
  const expected = new Error('failed');

  await assert.rejects(
    queue.enqueue(peer, async () => {
      throw expected;
    }),
    expected,
  );
  await queue.enqueue(peer, async () => undefined);
  await queue.waitForIdle(peer);
});
