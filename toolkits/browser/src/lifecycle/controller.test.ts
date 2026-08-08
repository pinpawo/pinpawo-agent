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

// -- Stale vs. superseded generations (issue #583 review) --
// A *lower/older* generation is stale and is silently dropped. A *higher*
// generation means the bridge moved on (target closed, reconnected): our
// navigation's context is obsolete, so waiters must get a determinate result
// instead of hanging until the deadline.
test('a stale event from an older connection generation is dropped', () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1);
  // Event from generation 0 (< the bound 1) — stale, silently dropped.
  controller.handleEvent(committedEvent(0, 1, 1, 'https://example.com/'));
  assert.equal(controller.getSnapshot().navigation?.phase, 'requested');
});

test('notifyGenerationAdvance with a newer connection generation fails with runtime_disconnected', () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1);
  const snapshot = controller.notifyGenerationAdvance(2, 1);
  assert.equal(snapshot.navigation?.phase, 'failed');
  assert.equal(snapshot.navigation?.error?.code, 'runtime_disconnected');
  // A dropped connection is recoverable by rebinding → retryable.
  assert.equal(snapshot.navigation?.error?.retryable, true);
});

test('notifyGenerationAdvance with a newer target generation fails with target_closed', () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1);
  const snapshot = controller.notifyGenerationAdvance(1, 2);
  assert.equal(snapshot.navigation?.phase, 'failed');
  assert.equal(snapshot.navigation?.error?.code, 'target_closed');
  // The tab is gone; retrying the same target cannot succeed → not retryable.
  assert.equal(snapshot.navigation?.error?.retryable, false);
});

test('notifyGenerationAdvance is a no-op when the bridge generation did not advance', () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1);
  controller.handleEvent(committedEvent(1, 1, 1, 'https://example.com/'));
  const snapshot = controller.notifyGenerationAdvance(1, 1);
  assert.equal(snapshot.navigation?.phase, 'committed');
  assert.equal(snapshot.navigation?.error, undefined);
});

// -- Coordinate the two counters (review #4: one owner, no desync) --
test('beginNavigation binds an external navigationGeneration from the bridge', () => {
  const controller = new BrowserLifecycleController();
  // The bridge owns the counter; here it reports generation 7. The controller
  // must bind to that value, not mint its own.
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1, 7);
  assert.equal(controller.getSnapshot().context?.navigationGeneration, 7);
  // An event stamped with the bridge's generation is accepted as current.
  const snapshot = controller.handleEvent(committedEvent(1, 1, 7, 'https://example.com/'));
  assert.equal(snapshot.navigation?.phase, 'committed');
  // A stale event from a different generation is still rejected.
  controller.handleEvent(committedEvent(1, 1, 8, 'https://example.com/other'));
  assert.equal(controller.getSnapshot().navigation?.committedUrl, 'https://example.com/');
});

// -- A stale navigation event must not kill the current nav (review :superseded)
//    A late event from an old navigation can carry a *newer* target generation.
//    Before this fix that was misread as "the current target superseded our nav"
//    and terminally failed a healthy navigation. Now the strict `isEventCurrent`
//    check drops it, and authoritative bumps go through `notifyGenerationAdvance`.
test('a stale old-navigation event with a newer target generation is dropped, not fatal', () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1);
  controller.handleEvent(committedEvent(1, 1, 1, 'https://example.com/'));
  // Old-navigation (gen 0) late `document.ready` carrying targetGeneration 2:
  // stamped for a *different* target than our navigation — stale, must drop,
  // and must NOT fail the current navigation.
  controller.handleEvent({
    connectionGeneration: 1,
    targetGeneration: 2,
    navigationGeneration: 0,
    tabId: 5,
    timestamp: 0,
    type: 'document.ready',
    payload: { readyState: 'complete' },
  });
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.navigation?.phase, 'committed');
  assert.equal(snapshot.navigation?.error, undefined);
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

test('local fallback after an external binding never regresses the generation', () => {
  const controller = new BrowserLifecycleController();
  // Bind to an external (bridge-owned) generation.
  controller.beginNavigation('https://a.com/', 'https://a.com', 1, 1, 7);
  assert.equal(controller.getSnapshot().context?.navigationGeneration, 7);
  // Omit the external generation: the local fallback must not mint a lower
  // generation (1) that would let a stale higher-numbered event be misread as
  // current. It keeps advancing from the highest value ever bound.
  controller.beginNavigation('https://b.com/', 'https://b.com', 1, 1);
  assert.equal(
    controller.getSnapshot().context?.navigationGeneration ?? 0,
    8,
  );
  // And it keeps advancing on subsequent local fallbacks too.
  controller.beginNavigation('https://c.com/', 'https://c.com', 1, 1);
  assert.equal(
    controller.getSnapshot().context?.navigationGeneration ?? 0,
    9,
  );
});

// -- A url-less commit is malformed, not a benign intermediate (review #3) --
test('a url-less navigation.committed is explicitly ignored, not treated as intermediate', () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1);
  controller.handleEvent({
    connectionGeneration: 1,
    targetGeneration: 1,
    navigationGeneration: 1,
    tabId: 1,
    timestamp: 0,
    type: 'navigation.committed',
    // no `url` — malformed (the legacy `tab.navigated` can arrive without a URL)
  });
  const snapshot = controller.getSnapshot();
  // Nav stays in `requested`, and crucially it must NOT be silently accepted as
  // if it committed into the current navigation.
  assert.equal(snapshot.navigation?.phase, 'requested');
  assert.equal(snapshot.navigation?.committedUrl, undefined);
});

// -- Bridge-shaped events (review #1) --
// The bridge stamps connection + target generation but (before fixing the
// emission) never `navigationGeneration`. Such an event must still be accepted
// as belonging to the current navigation, not mis-rejected as stale purely
// because it lacks a navigation generation.
test('a bridge-shaped event without navigationGeneration is accepted as current', () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1);
  controller.handleEvent({
    connectionGeneration: 1,
    targetGeneration: 1,
    // note: no `navigationGeneration`
    tabId: 1,
    timestamp: 0,
    type: 'navigation.committed',
    url: 'https://example.com/',
  });
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.navigation?.phase, 'committed');
  assert.equal(snapshot.navigation?.committedUrl, 'https://example.com/');
});

// -- A superseded navigation generation is a stale event (SPA route) and is
//    dropped — it must not fail the current navigation (that would be wrong,
//    since the older navigation's late events simply no longer apply). --
test('a stale navigation-generation commit is dropped, not failing the current nav', () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1);
  controller.handleEvent({
    connectionGeneration: 1,
    targetGeneration: 1,
    navigationGeneration: 5,
    tabId: 5,
    timestamp: 0,
    type: 'document.ready',
    payload: { readyState: 'complete' },
  });
  // The pending navigation is generation 1, so a navGeneration-5 event is stale
  // and dropped — current state (requested) is untouched.
  assert.equal(controller.getSnapshot().navigation?.phase, 'requested');
});
