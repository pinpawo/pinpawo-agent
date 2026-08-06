import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTargetStack,
  isNavigableWebTab,
  isWebTab,
  selectNavigationTarget,
  shouldTrackPopup,
} from './targetLifecycle.js';

test('target stack follows child tabs and falls back when they close', () => {
  const targets = createTargetStack({ tabId: 10, binding: 'user' });

  targets.bind(
    { tabId: 11, binding: 'user' },
    { rememberCurrent: true },
  );
  targets.bind(
    { tabId: 12, binding: 'user' },
    { rememberCurrent: true },
  );

  assert.deepEqual(targets.current(), { tabId: 12, binding: 'user' });
  assert.deepEqual(targets.history(), [
    { tabId: 10, binding: 'user' },
    { tabId: 11, binding: 'user' },
  ]);
  assert.deepEqual(targets.remove(12), {
    closedCurrent: true,
    current: { tabId: 11, binding: 'user' },
  });
  assert.deepEqual(targets.remove(11), {
    closedCurrent: true,
    current: { tabId: 10, binding: 'user' },
  });
});

test('explicit tab binding resets popup history', () => {
  const targets = createTargetStack({ tabId: 10, binding: 'agent' });
  targets.bind(
    { tabId: 11, binding: 'agent' },
    { rememberCurrent: true },
  );
  targets.bind(
    { tabId: 20, binding: 'user' },
    { resetHistory: true },
  );

  assert.deepEqual(targets.history(), []);
  assert.deepEqual(targets.remove(20), { closedCurrent: true, current: null });
});

test('target history remains bounded during popup chains', () => {
  const targets = createTargetStack({ tabId: 1, binding: 'agent' }, 2);
  targets.bind({ tabId: 2, binding: 'agent' }, { rememberCurrent: true });
  targets.bind({ tabId: 3, binding: 'agent' }, { rememberCurrent: true });
  targets.bind({ tabId: 4, binding: 'agent' }, { rememberCurrent: true });

  assert.deepEqual(targets.history().map((target) => target.tabId), [2, 3]);
});

test('navigation preserves an explicitly user-bound tab', () => {
  assert.equal(selectNavigationTarget(null), 'create_agent_tab');
  assert.equal(
    selectNavigationTarget({ tabId: 10, binding: 'user' }),
    'create_agent_tab',
  );
  assert.equal(
    selectNavigationTarget({ tabId: 11, binding: 'agent' }),
    'reuse_agent_tab',
  );
});

test('navigation settles on a completed web page without approving its origin', () => {
  assert.equal(isNavigableWebTab({
    status: 'complete',
    url: 'https://www.example.com/',
  }), true);
  assert.equal(isNavigableWebTab({
    status: 'complete',
    url: 'about:blank#blocked',
  }), false);
  assert.equal(isNavigableWebTab({
    status: 'loading',
    pendingUrl: 'https://example.com/',
  }), false);
});

test('web target detection rejects internal and blocked blank pages', () => {
  assert.equal(isWebTab({
    status: 'loading',
    url: 'https://example.com/path',
  }), true);
  assert.equal(isWebTab({
    status: 'loading',
    pendingUrl: 'http://example.com/',
  }), true);
  assert.equal(isWebTab({ url: 'about:blank', status: 'complete' }), false);
  assert.equal(isWebTab({ url: 'about:blank#blocked', status: 'complete' }), false);
  assert.equal(isWebTab({ url: 'chrome://extensions/', status: 'complete' }), false);
});

test('a new navigation clears obsolete popup fallback history', () => {
  const targets = createTargetStack({ tabId: 10, binding: 'agent' });
  targets.bind({ tabId: 11, binding: 'agent' }, { rememberCurrent: true });

  targets.bind({ tabId: 11, binding: 'agent' }, { resetHistory: true });

  assert.deepEqual(targets.history(), []);
  assert.deepEqual(targets.remove(11), { closedCurrent: true, current: null });
});

test('only a live command tracks its own popup', () => {
  const target = { tabId: 10, binding: 'agent' };
  assert.equal(shouldTrackPopup(null, target, 10), false);
  assert.equal(shouldTrackPopup(10, target, 11), false);
  assert.equal(shouldTrackPopup(10, target, 10), true);
});
