import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserStateTracker } from './browserState.js';

test('browser state snapshots retain the current revision until a state change is published', () => {
  const state = createBrowserStateTracker();
  const target = { tabId: 42, ownership: 'user' };

  assert.deepEqual(state.snapshot(target, null), {
    revision: 0,
    debuggerAttached: false,
    activeTab: target,
  });

  assert.equal(state.advance(), 1);
  assert.deepEqual(state.snapshot(target, 42), {
    revision: 1,
    debuggerAttached: true,
    activeTab: target,
  });

  assert.equal(state.advance(), 2);
  assert.equal(state.snapshot(null, null).revision, 2);
});
