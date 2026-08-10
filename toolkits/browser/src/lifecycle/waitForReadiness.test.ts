import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserLifecycleController } from './controller';
import { SETTLING_WINDOW_MS } from './navigation';
import { waitForReadiness } from './waitForReadiness';
import type { BrowserRuntimeEvent } from './events';

function committedEvent(
  connectionGeneration: number,
  targetGeneration: number,
  navigationGeneration: number,
  url: string,
  timestamp: number,
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

function documentReady(timestamp: number): BrowserRuntimeEvent {
  return {
    connectionGeneration: 1,
    targetGeneration: 1,
    navigationGeneration: 1,
    tabId: 1,
    timestamp,
    type: 'document.ready',
    payload: { readyState: 'complete' },
  };
}

function networkQuiet(timestamp: number): BrowserRuntimeEvent {
  return {
    connectionGeneration: 1,
    targetGeneration: 1,
    navigationGeneration: 1,
    tabId: 1,
    timestamp,
    type: 'network.activity',
    payload: { inflightRequests: 0 },
  };
}

function domChanged(timestamp: number): BrowserRuntimeEvent {
  return {
    connectionGeneration: 1,
    targetGeneration: 1,
    navigationGeneration: 1,
    tabId: 1,
    timestamp,
    type: 'dom.changed',
    payload: { textLength: 1200, textRevision: 2 },
  };
}

test('waitForReadiness resolves when the navigation reaches readable', async () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1, 1);
  const base = 10_000;
  const wait = waitForReadiness(controller, {
    deadlineMs: 1_000,
    now: () => cur,
  });
  let cur = base;
  wait.feed(committedEvent(1, 1, 1, 'https://example.com/', base));
  wait.feed(documentReady(base));
  wait.feed(networkQuiet(base));
  wait.feed(domChanged(base));
  // Advance the clock past the settling window so the poll marks it readable.
  cur = base + 50 + SETTLING_WINDOW_MS;
  wait.feed(domChanged(cur));
  const result = await wait.finished;
  assert.equal(result.status, 'resolved');
  wait.dispose();
});

test('waitForReadiness resolves failed with origin_changed on a cross-origin commit', async () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1, 1);
  const wait = waitForReadiness(controller, { deadlineMs: 1_000, now: () => 0 });
  wait.feed(committedEvent(1, 1, 1, 'https://attacker.test/steal', 0));
  const result = await wait.finished;
  assert.equal(result.status, 'failed');
  assert.ok(result.status === 'failed');
  assert.equal(result.failure.error.code, 'origin_changed');
  assert.equal(result.failure.diagnostics.phase, 'failed');
  wait.dispose();
});

test('waitForReadiness fails with runtime_disconnected on a generation bump', async () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1, 1);
  const wait = waitForReadiness(controller, { deadlineMs: 1_000, now: () => 0 });
  wait.feed(committedEvent(1, 1, 1, 'https://example.com/', 0));
  wait.generationChanged(2, 1);
  const result = await wait.finished;
  assert.equal(result.status, 'failed');
  assert.ok(result.status === 'failed');
  assert.equal(result.failure.error.code, 'runtime_disconnected');
  wait.dispose();
});

test('waitForReadiness fails with target_closed on a target generation bump', async () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1, 1);
  const wait = waitForReadiness(controller, { deadlineMs: 1_000, now: () => 0 });
  wait.feed(committedEvent(1, 1, 1, 'https://example.com/', 0));
  wait.generationChanged(1, 2);
  const result = await wait.finished;
  assert.equal(result.status, 'failed');
  assert.ok(result.status === 'failed');
  assert.equal(result.failure.error.code, 'target_closed');
  wait.dispose();
});

test('waitForReadiness times out with diagnostics when the deadline elapses', async () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1, 1);
  // A very short deadline so the wall-clock timer fires without any readiness.
  const wait = waitForReadiness(controller, { deadlineMs: 5, now: () => Date.now() });
  wait.feed(committedEvent(1, 1, 1, 'https://example.com/', Date.now()));
  const result = await wait.finished;
  assert.equal(result.status, 'timed_out');
  assert.ok(result.status === 'timed_out');
  // Diagnostics carry the committed URL so the caller can guide browser_wait.
  assert.equal(result.timeout.diagnostics.committedUrl, 'https://example.com/');
  assert.equal(result.timeout.diagnostics.phase, 'committed');
  wait.dispose();
});

test('feed after settlement is a no-op', async () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1, 1);
  const wait = waitForReadiness(controller, { deadlineMs: 1_000, now: () => 0 });
  wait.feed(committedEvent(1, 1, 1, 'https://attacker.test/steal', 0));
  const first = await wait.finished;
  assert.equal(first.status, 'failed');
  // Feeding more events must not change the settled result.
  wait.feed(committedEvent(1, 1, 1, 'https://example.com/', 0));
  const again = await wait.finished;
  assert.equal(again.status, 'failed');
  wait.dispose();
});
