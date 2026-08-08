import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserLifecycleController } from './controller';
import { SETTLING_WINDOW_MS } from './navigation';
import {
  driveOpenReadiness,
  evaluateOpenReadiness,
  OPEN_READINESS_DEADLINE_MS,
} from './openReadiness';
import type { BrowserRuntimeEvent } from './events';

const T0 = 10_000;
// A point comfortably past the network settle window after the last network
// activity at T0+30, so a poll there observes a quiet page.
const AFTER_SETTLE = T0 + 30 + SETTLING_WINDOW_MS + 50;

function committed(url: string, ts = T0, nav = 1): BrowserRuntimeEvent {
  return { connectionGeneration: 1, targetGeneration: 1, navigationGeneration: nav, tabId: 1, timestamp: ts, type: 'navigation.committed', url };
}
function ready(readyState: 'loading' | 'interactive' | 'complete', ts: number, nav = 1): BrowserRuntimeEvent {
  return { connectionGeneration: 1, targetGeneration: 1, navigationGeneration: nav, tabId: 1, timestamp: ts, type: 'document.ready', payload: { readyState } };
}
function network(inflight: number, ts: number, nav = 1): BrowserRuntimeEvent {
  return { connectionGeneration: 1, targetGeneration: 1, navigationGeneration: nav, tabId: 1, timestamp: ts, type: 'network.activity', payload: { inflightRequests: inflight } };
}
function dom(textLength: number, textRevision: number, ts: number, nav = 1): BrowserRuntimeEvent {
  return { connectionGeneration: 1, targetGeneration: 1, navigationGeneration: nav, tabId: 1, timestamp: ts, type: 'dom.changed', payload: { textLength, textRevision } };
}
function committedEvent(conn: number, target: number, nav: number, url: string, timestamp = 0): BrowserRuntimeEvent {
  return { connectionGeneration: conn, targetGeneration: target, navigationGeneration: nav, tabId: 1, timestamp, type: 'navigation.committed', url };
}

test('opens to readable for a normal page', () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1);
  const outcome = driveOpenReadiness(
    controller,
    [
      committed('https://example.com/', T0),
      ready('complete', T0 + 10),
      network(2, T0 + 20),
      network(0, T0 + 30),
      dom(1500, 3, AFTER_SETTLE),
    ],
    T0,
  );
  assert.equal(outcome.status, 'readable');

  // Also directly verifiable via the convenience helper.
  const quick = evaluateOpenReadiness(
    [
      committed('https://example.com/', T0),
      ready('complete', T0 + 10),
      network(0, T0 + 30),
      dom(800, 1, AFTER_SETTLE),
    ],
    T0,
    { requestedUrl: 'https://example.com/', approvedOrigin: 'https://example.com' },
  );
  assert.equal(quick.status, 'readable');
});

test('fails fast on a cross-origin redirect (origin_changed)', () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1);
  const outcome = driveOpenReadiness(controller, [committed('https://attacker.test/steal', T0)], T0);
  assert.equal(outcome.status, 'failed');
  assert.ok(outcome.status === 'failed');
  assert.equal(outcome.error.code, 'origin_changed');
  assert.equal(outcome.error.retryable, false);
});

test('timed out if the page never becomes readable by the deadline', () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1);
  // Shell complete but body text never sampled → never readable. Report
  // `timed_out` once the real deadline (injected clock) has passed, not merely
  // because the recorded event array ended.
  const outcome = driveOpenReadiness(
    controller,
    [
      committed('https://example.com/', T0),
      ready('complete', T0 + 5),
      network(0, T0 + 10),
    ],
    T0,
    { deadlineMs: 1000, now: () => T0 + 1001 },
  );
  assert.equal(outcome.status, 'timed_out');
});

test('a page that goes quiet before the deadline is pending, not timed_out', () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1);
  // Events stop mid-navigation; the injected clock has NOT yet passed the
  // deadline. This must NOT be reported as `timed_out` merely because the
  // array ended — the driver leaves it `pending` for the caller to keep polling.
  const outcome = driveOpenReadiness(
    controller,
    [
      committed('https://example.com/', T0),
      ready('complete', T0 + 5),
      network(0, T0 + 10),
    ],
    T0,
    { deadlineMs: 1000, now: () => T0 + 500 },
  );
  assert.equal(outcome.status, 'pending');
});

test('default deadline equals the controller navigation timeout', () => {
  assert.equal(OPEN_READINESS_DEADLINE_MS, 30_000);
});

// -- SPA shell: document complete but body text not sampled yet (volcengine) --
test('SPA shell is NOT readable until the body text is sampled', () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://volcengine.com/', 'https://volcengine.com', 1, 1);
  // Shell committed + document complete, but no `dom.changed`/text sample.
  const outcome = driveOpenReadiness(
    controller,
    [
      committed('https://volcengine.com/', T0),
      ready('complete', T0 + 5),
      network(0, T0 + 10),
    ],
    T0,
    { deadlineMs: 2000 },
  );
  // No body text sample ⇒ never readable within the window.
  assert.notEqual(outcome.status, 'readable');

  // Once the body text arrives (past the settle window), the page becomes readable.
  const full = new BrowserLifecycleController();
  full.beginNavigation('https://volcengine.com/', 'https://volcengine.com', 1, 1);
  const complete = driveOpenReadiness(
    full,
    [
      committed('https://volcengine.com/', T0),
      ready('complete', T0 + 5),
      network(0, T0 + 10),
      dom(4200, 2, AFTER_SETTLE),
    ],
    T0,
    { deadlineMs: 2000 },
  );
  assert.equal(complete.status, 'readable');
});

// -- Long-lived WebSocket/SSE never reports inflight requests →
//    must not block readiness forever --
test('long-lived connection with no inflight updates does not block readiness', () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://stream.example/', 'https://stream.example', 1, 1);
  const outcome = driveOpenReadiness(
    controller,
    [
      committed('https://stream.example/', T0),
      ready('complete', T0 + 5),
      // No network.activity at all — long-lived socket that never reports
      // inflight requests. DOM text is present and settled.
      dom(900, 2, AFTER_SETTLE),
    ],
    T0,
    { deadlineMs: 2000 },
  );
  assert.equal(outcome.status, 'readable');
});

// -- DOM churn must not re-arm the network settle window, and the page still
//    settles despite recurring DOM mutations. --
test('recurring DOM mutations do not block readiness once network is quiet', () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://ticker.example/', 'https://ticker.example', 1, 1);
  const outcome = driveOpenReadiness(
    controller,
    [
      committed('https://ticker.example/', T0),
      ready('complete', T0 + 5),
      network(0, T0 + 10),
      dom(1000, 2, T0 + 12),
      dom(1010, 3, T0 + 20),
      dom(1020, 4, AFTER_SETTLE),
    ],
    T0,
    { deadlineMs: 2000 },
  );
  // DOM churn is tracked on its own field and never re-arms the network settle
  // window, so the page is readable once network quiets + text is present.
  assert.equal(outcome.status, 'readable');
});

// -- SPA route change: a same-origin commit while `readable` re-arms the
//    readiness tracking for the newly committed document. --
test('SPA same-origin route change re-arms readiness', () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://spa.example/books', 'https://spa.example', 1, 1);
  const first = driveOpenReadiness(
    controller,
    [
      committed('https://spa.example/books', T0),
      ready('complete', T0 + 5),
      network(0, T0 + 10),
      dom(2000, 2, AFTER_SETTLE),
    ],
    T0,
  );
  assert.equal(first.status, 'readable');

  // Client-side navigation to a new route within the same origin.
  const secondStart = T0 + 2000;
  const second = driveOpenReadiness(
    controller,
    [
      committed('https://spa.example/chapters', secondStart),
      ready('complete', secondStart + 5),
      network(0, secondStart + 10),
      dom(600, 2, secondStart + 30 + SETTLING_WINDOW_MS),
    ],
    secondStart,
  );
  assert.equal(second.status, 'readable');
  assert.equal(second.snapshot.navigation?.committedUrl, 'https://spa.example/chapters');
});

// -- Stale generation events are rejected: a commit from an old navigation
//    generation must not move the current one. --
test('a stale navigation-generation commit is rejected', () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1);
  // Event from a superseded navigation generation (0).
  controller.handleEvent(committedEvent(1, 1, 0, 'https://attacker.test/steal'));
  assert.equal(controller.getSnapshot().navigation?.phase, 'requested');
  assert.equal(controller.getSnapshot().navigation?.committedUrl, undefined);
});

test('driveOpenReadiness honors a supplied poll cadence', () => {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1);
  // Only poll after the quiet window has elapsed.
  const outcome = driveOpenReadiness(
    controller,
    [
      committed('https://example.com/', T0),
      ready('complete', T0 + 10),
      network(2, T0 + 20),
      network(0, T0 + 30),
      dom(1500, 3, AFTER_SETTLE),
    ],
    T0,
    {
      deadlineMs: 10000,
      shouldPoll: (_event, now) => now >= AFTER_SETTLE,
    },
  );
  assert.equal(outcome.status, 'readable');
});
