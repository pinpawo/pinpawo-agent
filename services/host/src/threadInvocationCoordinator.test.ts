import assert from 'node:assert/strict';
import test from 'node:test';
import { ThreadInvocationCoordinator } from './threadInvocationCoordinator';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test('ThreadInvocationCoordinator waits for the previous invocation to settle', async () => {
  const coordinator = new ThreadInvocationCoordinator();
  const firstController = new AbortController();
  const first = coordinator.enqueue({
    threadId: 'thread-1',
    requestId: 'request-1',
    signal: firstController.signal,
    abort: () => firstController.abort(),
  });
  await first.waitForTurn();

  const secondController = new AbortController();
  const second = coordinator.enqueue({
    threadId: 'thread-1',
    requestId: 'request-2',
    signal: secondController.signal,
    abort: () => secondController.abort(),
  });
  assert.equal(firstController.signal.aborted, true);

  let secondStarted = false;
  const secondTurn = second.waitForTurn().then(() => {
    secondStarted = true;
  });
  await Promise.resolve();
  assert.equal(secondStarted, false);

  first.settle();
  await secondTurn;
  assert.equal(secondStarted, true);
  second.settle();
});

test('ThreadInvocationCoordinator skips a queued invocation superseded by a newer request', async () => {
  const coordinator = new ThreadInvocationCoordinator();
  const firstController = new AbortController();
  const first = coordinator.enqueue({
    threadId: 'thread-1',
    requestId: 'request-1',
    signal: firstController.signal,
    abort: () => firstController.abort(),
  });
  await first.waitForTurn();

  const secondController = new AbortController();
  const second = coordinator.enqueue({
    threadId: 'thread-1',
    requestId: 'request-2',
    signal: secondController.signal,
    abort: () => secondController.abort(),
  });
  const secondTurn = second.waitForTurn();

  const thirdController = new AbortController();
  const third = coordinator.enqueue({
    threadId: 'thread-1',
    requestId: 'request-3',
    signal: thirdController.signal,
    abort: () => thirdController.abort(),
  });
  assert.equal(secondController.signal.aborted, true);

  first.settle();
  await assert.rejects(secondTurn, { name: 'AbortError' });
  second.settle();
  await third.waitForTurn();
  third.settle();
});

test('ThreadInvocationCoordinator allows different threads to run concurrently', async () => {
  const coordinator = new ThreadInvocationCoordinator();
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = coordinator.enqueue({
    threadId: 'thread-1',
    requestId: 'request-1',
    signal: firstController.signal,
    abort: () => firstController.abort(),
  });
  const second = coordinator.enqueue({
    threadId: 'thread-2',
    requestId: 'request-2',
    signal: secondController.signal,
    abort: () => secondController.abort(),
  });

  await Promise.all([first.waitForTurn(), second.waitForTurn()]);
  assert.equal(firstController.signal.aborted, false);
  assert.equal(secondController.signal.aborted, false);
  first.settle();
  second.settle();
});
