import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserStateTracker } from './browserState.js';

test('browser state snapshots retain the current revision until a state change is published', () => {
  const state = createBrowserStateTracker();
  const target = { tabId: 42, binding: 'user' } as const;

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

test('browser state exposes an origin only for an explicit user binding', () => {
  const state = createBrowserStateTracker();
  const userTarget = { tabId: 42, binding: 'user' } as const;
  const agentTarget = { tabId: 7, binding: 'agent' } as const;

  assert.deepEqual(state.snapshot(userTarget, null, 'https://example.com'), {
    revision: 0,
    debuggerAttached: false,
    activeTab: userTarget,
    userBoundOrigin: 'https://example.com',
  });
  assert.deepEqual(state.snapshot(agentTarget, null, 'https://example.com'), {
    revision: 0,
    debuggerAttached: false,
    activeTab: agentTarget,
  });
});

test('browser state reports every context\'s current tab and user grant (#867)', () => {
  const state = createBrowserStateTracker();
  const contexts = {
    'context-a': { tabId: 42, binding: 'user' as const, userBoundOrigin: 'https://mail.example' },
    'context-b': { tabId: 7, binding: 'agent' as const },
  };
  assert.deepEqual(state.snapshot(null, null, null, contexts).contexts, contexts);
  assert.equal('contexts' in state.snapshot(null, null), false);
});
