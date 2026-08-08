import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserLifecycleController } from './controller';
import { SETTLING_WINDOW_MS } from './navigation';
import type { BrowserRuntimeEvent } from './events';

function committedEvent(
  connectionGeneration: number,
  targetGeneration: number,
  navigationGeneration: number,
  url: string,
  timestamp = 0,
): BrowserRuntimeEvent {
  return {
    connectionGeneration,
    targetGeneration,
    navigationGeneration,
    tabId: 1,
    timestamp,
    type: 'navigation.committed',
    url,
  };
}

test('controller reports no active navigation before beginNavigation', () => {
  const controller = new BrowserLifecycleController();
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.hasActiveNavigation, false);
  assert.equal(snapshot.navigation, null);
  assert.equal(snapshot.context, null);
});

test('beginNavigation creates a fresh navigation generation in requested phase', () => {
  const controller = new BrowserLifecycleController();
  const snapshot = controller.beginNavigation(
    'https://example.com/',
    'https://example.com',
    1,
    1,
  );
  assert.equal(snapshot.hasActiveNavigation, true);
  assert.equal(snapshot.navigation?.phase, 'requested');
  assert.equal(snapshot.navigation?.readable, false);
  assert.equal(snapshot.context?.navigationGeneration, 1);
});

test('a current commit moves the navigation to committed', () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1);
  controller.handleEvent(
    committedEvent(1, 1, 1, 'https://example.com/'),
  );
  assert.equal(controller.getSnapshot().navigation?.phase, 'committed');
  assert.equal(controller.getSnapshot().navigation?.committedUrl, 'https://example.com/');
});

test('a stale (superseded-generation) commit is dropped', () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1);
  // Event from a previous/superseded navigation generation 0.
  controller.handleEvent(committedEvent(1, 1, 0, 'https://example.com/'));
  assert.equal(controller.getSnapshot().navigation?.phase, 'requested');
  assert.equal(controller.getSnapshot().navigation?.committedUrl, undefined);
});

test('an event from a different connection generation is dropped', () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1);
  controller.handleEvent(committedEvent(2, 1, 1, 'https://example.com/'));
  assert.equal(controller.getSnapshot().navigation?.phase, 'requested');
});

test('a cross-origin commit fails the navigation with origin_changed', () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1);
  controller.handleEvent(committedEvent(1, 1, 1, 'https://attacker.test/steal'));
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.navigation?.phase, 'failed');
  assert.equal(snapshot.navigation?.error?.code, 'origin_changed');
  assert.equal(snapshot.navigation?.readable, false);
});

test('pollReadiness marks the page readable once the policy passes', () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1);
  const base = 10_000;
  controller.handleEvent(committedEvent(1, 1, 1, 'https://example.com/', base));
  controller.handleEvent({
    connectionGeneration: 1,
    targetGeneration: 1,
    navigationGeneration: 1,
    tabId: 1,
    timestamp: base,
    type: 'document.ready',
    payload: { readyState: 'complete' },
  });
  // Establish a network-active baseline, then quiet down.
  controller.handleEvent({
    connectionGeneration: 1,
    targetGeneration: 1,
    navigationGeneration: 1,
    tabId: 1,
    timestamp: base,
    type: 'network.activity',
    payload: { inflightRequests: 2 },
  });
  controller.handleEvent({
    connectionGeneration: 1,
    targetGeneration: 1,
    navigationGeneration: 1,
    tabId: 1,
    timestamp: base + 50,
    type: 'network.activity',
    payload: { inflightRequests: 0 },
  });
  controller.handleEvent({
    connectionGeneration: 1,
    targetGeneration: 1,
    navigationGeneration: 1,
    tabId: 1,
    timestamp: base + 50,
    type: 'dom.changed',
    payload: { textLength: 1200, textRevision: 2 },
  });

  assert.equal(controller.getSnapshot().navigation?.phase, 'dom_ready');

  // Poll before the quiet window elapses → still not readable.
  controller.pollReadiness(base + 100);
  assert.equal(controller.getSnapshot().navigation?.readable, false);
  assert.equal(controller.getSnapshot().navigation?.phase, 'settling');

  // Poll once the quiet window has elapsed → readable.
  controller.pollReadiness(base + 100 + SETTLING_WINDOW_MS);
  assert.equal(controller.getSnapshot().navigation?.readable, true);
  assert.equal(controller.getSnapshot().navigation?.phase, 'readable');
});

test('fail() marks the navigation terminal and further events are ignored', () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1);
  controller.fail({
    code: 'navigation_settle_timeout',
    message: 'timed out',
    retryable: true,
  });
  assert.equal(controller.getSnapshot().navigation?.phase, 'failed');
  assert.equal(controller.getSnapshot().navigation?.error?.code, 'navigation_settle_timeout');

  // Events after failed are ignored.
  controller.handleEvent(committedEvent(1, 1, 1, 'https://example.com/'));
  assert.equal(controller.getSnapshot().navigation?.phase, 'failed');
});

test('beginNavigation advances the generation on each call', () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://a.com/', 'https://a.com', 1, 1);
  const g1 = controller.getSnapshot().context?.navigationGeneration;
  controller.beginNavigation('https://b.com/', 'https://b.com', 1, 1);
  const g2 = controller.getSnapshot().context?.navigationGeneration;
  assert.equal(typeof g1, 'number');
  assert.equal(g2, (g1 as number) + 1);
});
