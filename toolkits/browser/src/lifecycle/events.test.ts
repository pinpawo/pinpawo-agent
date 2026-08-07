import assert from 'node:assert/strict';
import test from 'node:test';
import { isEventCurrent, type BrowserRuntimeEvent } from './events';

function event(
  overrides: Partial<BrowserRuntimeEvent> & Pick<BrowserRuntimeEvent, 'type'>,
): BrowserRuntimeEvent {
  return {
    connectionGeneration: 1,
    targetGeneration: 5,
    navigationGeneration: 3,
    tabId: 10,
    timestamp: 0,
    ...overrides,
  };
}

test('a current event is accepted', () => {
  assert.equal(
    isEventCurrent(event({ type: 'document.ready' }), {
      connectionGeneration: 1,
      targetGeneration: 5,
      navigationGeneration: 3,
    }),
    true,
  );
});

test('a stale connection generation is rejected', () => {
  assert.equal(
    isEventCurrent(event({ type: 'document.ready', connectionGeneration: 0 }), {
      connectionGeneration: 1,
      targetGeneration: 5,
      navigationGeneration: 3,
    }),
    false,
  );
});

test('a stale target generation is rejected', () => {
  assert.equal(
    isEventCurrent(event({ type: 'document.ready', targetGeneration: 2 }), {
      connectionGeneration: 1,
      targetGeneration: 5,
      navigationGeneration: 3,
    }),
    false,
  );
});

test('a stale navigation generation is rejected', () => {
  assert.equal(
    isEventCurrent(event({ type: 'document.ready', navigationGeneration: 1 }), {
      connectionGeneration: 1,
      targetGeneration: 5,
      navigationGeneration: 3,
    }),
    false,
  );
});

test('events without a navigation generation are not rejected purely on navigation', () => {
  assert.equal(
    isEventCurrent(event({ type: 'target.created', navigationGeneration: undefined }), {
      connectionGeneration: 1,
      targetGeneration: 5,
      navigationGeneration: 3,
    }),
    true,
  );
});
