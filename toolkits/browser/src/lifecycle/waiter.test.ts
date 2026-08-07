import assert from 'node:assert/strict';
import test from 'node:test';
import { PendingWait } from './waiter';

test('a wait resolves once with the settled value', async () => {
  const wait = new PendingWait<number>({ timeoutMs: 500 });
  assert.equal(wait.settle(42), true);
  const outcome = await wait.done;
  assert.deepEqual(outcome, { status: 'resolved', value: 42 });
});

test('a waiter settles only once; later settles are ignored', async () => {
  const wait = new PendingWait<number>({ timeoutMs: 500 });
  wait.settle(1);
  assert.equal(wait.settle(2), false);
  const outcome = await wait.done;
  assert.deepEqual(outcome, { status: 'resolved', value: 1 });
});

test('a wait times out after the deadline without a settle', async () => {
  const wait = new PendingWait<number>({ timeoutMs: 10 });
  const outcome = await wait.done;
  assert.equal(outcome.status, 'timed_out');
});

test('an already-aborted signal resolves the wait as cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  const wait = new PendingWait<number>({ timeoutMs: 100, signal: controller.signal });
  const outcome = await wait.done;
  assert.equal(outcome.status, 'cancelled');
});

test('aborting the signal during the wait resolves as cancelled', async () => {
  const controller = new AbortController();
  const wait = new PendingWait<number>({ timeoutMs: 500, signal: controller.signal });
  controller.abort();
  const outcome = await wait.done;
  assert.equal(outcome.status, 'cancelled');
});

test('forfeit(timed_out) releases a pending waiter', async () => {
  const wait = new PendingWait<number>({ timeoutMs: 500 });
  assert.equal(wait.forfeit('timed_out'), true);
  const outcome = await wait.done;
  assert.equal(outcome.status, 'timed_out');
});

test('settling clears the timeout timer', async () => {
  const wait = new PendingWait<string>({ timeoutMs: 200 });
  wait.settle('early');
  const outcome = await wait.done;
  assert.deepEqual(outcome, { status: 'resolved', value: 'early' });
});
