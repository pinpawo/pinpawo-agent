import assert from 'node:assert/strict';
import test from 'node:test';
import { createTargetStack } from './targetLifecycle.js';

test('target stack follows child tabs and falls back when they close', () => {
  const targets = createTargetStack({ tabId: 10, ownership: 'user' });

  targets.bind(
    { tabId: 11, ownership: 'user' },
    { rememberCurrent: true },
  );
  targets.bind(
    { tabId: 12, ownership: 'user' },
    { rememberCurrent: true },
  );

  assert.deepEqual(targets.current(), { tabId: 12, ownership: 'user' });
  assert.deepEqual(targets.history(), [
    { tabId: 10, ownership: 'user' },
    { tabId: 11, ownership: 'user' },
  ]);
  assert.deepEqual(targets.remove(12), {
    closedCurrent: true,
    current: { tabId: 11, ownership: 'user' },
  });
  assert.deepEqual(targets.remove(11), {
    closedCurrent: true,
    current: { tabId: 10, ownership: 'user' },
  });
});

test('explicit tab binding resets popup history', () => {
  const targets = createTargetStack({ tabId: 10, ownership: 'agent' });
  targets.bind(
    { tabId: 11, ownership: 'agent' },
    { rememberCurrent: true },
  );
  targets.bind(
    { tabId: 20, ownership: 'user' },
    { resetHistory: true },
  );

  assert.deepEqual(targets.history(), []);
  assert.deepEqual(targets.remove(20), { closedCurrent: true, current: null });
});

test('target history remains bounded during popup chains', () => {
  const targets = createTargetStack({ tabId: 1, ownership: 'agent' }, 2);
  targets.bind({ tabId: 2, ownership: 'agent' }, { rememberCurrent: true });
  targets.bind({ tabId: 3, ownership: 'agent' }, { rememberCurrent: true });
  targets.bind({ tabId: 4, ownership: 'agent' }, { rememberCurrent: true });

  assert.deepEqual(targets.history().map((target) => target.tabId), [2, 3]);
});
