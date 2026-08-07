import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyNavigationEvent,
  createNavigation,
  createNavigationRegistry,
  defaultPageReadinessPolicy,
  SETTLING_WINDOW_MS,
} from './navigation';

test('navigation generations increase monotonically', () => {
  const registry = createNavigationRegistry();
  const g1 = registry.nextGeneration();
  const g2 = registry.nextGeneration();
  assert.equal(g2, g1 + 1);
});

test('a fresh navigation starts in the requested phase', () => {
  const navigation = createNavigation(1, 'https://example.com/', 'https://example.com');
  assert.deepEqual(
    { generation: navigation.generation, phase: navigation.phase, requestedUrl: navigation.requestedUrl, approvedOrigin: navigation.approvedOrigin },
    { generation: 1, phase: 'requested', requestedUrl: 'https://example.com/', approvedOrigin: 'https://example.com' },
  );
});

test('navigation moves requested → committed → dom_ready on events', () => {
  let navigation = createNavigation(1, 'https://example.com/', 'https://example.com');
  navigation = applyNavigationEvent(navigation, { kind: 'commit', url: 'https://example.com/' });
  assert.equal(navigation.phase, 'committed');
  assert.equal(navigation.committedUrl, 'https://example.com/');

  navigation = applyNavigationEvent(navigation, { kind: 'document.ready', readyState: 'interactive' });
  assert.equal(navigation.phase, 'dom_ready');
  assert.equal(navigation.readyState, 'interactive');
});

test('a settle verdict flips the page to readable when the readiness policy passes', () => {
  let navigation = createNavigation(1, 'https://example.com/', 'https://example.com');
  navigation = applyNavigationEvent(navigation, { kind: 'commit', url: 'https://example.com/' });
  navigation = applyNavigationEvent(navigation, { kind: 'document.ready', readyState: 'complete' });

  const readyInput = {
    readyState: navigation.readyState,
    inflightRequests: 0,
    textLength: 1200,
    textRevision: 2,
    lastNetworkActivityAt: 1_000,
    now: 1_000 + SETTLING_WINDOW_MS + 1,
  };
  navigation = applyNavigationEvent(
    navigation,
    { kind: 'settle_verdict', readable: defaultPageReadinessPolicy(readyInput), now: readyInput.now },
  );
  assert.equal(navigation.phase, 'readable');
});

test('a settle verdict does not prematurely flip while activity is recent', () => {
  let navigation = createNavigation(1, 'https://example.com/', 'https://example.com');
  navigation = applyNavigationEvent(navigation, { kind: 'commit', url: 'https://example.com/' });
  navigation = applyNavigationEvent(navigation, { kind: 'document.ready', readyState: 'complete' });
  navigation = applyNavigationEvent(navigation, { kind: 'dom', textLength: 200, textRevision: 1, now: 5_000 });

  const stillActive = {
    readyState: navigation.readyState,
    inflightRequests: 2,
    textLength: 200,
    textRevision: 1,
    lastNetworkActivityAt: 4_900,
    now: 5_000,
  };
  navigation = applyNavigationEvent(
    navigation,
    { kind: 'settle_verdict', readable: defaultPageReadinessPolicy(stillActive), now: stillActive.now },
  );
  assert.equal(navigation.phase, 'settling');
  assert.notEqual(navigation.phase, 'readable');
});

test('a failed navigation moves to the failed terminal phase', () => {
  let navigation = createNavigation(1, 'https://example.com/', 'https://example.com');
  navigation = applyNavigationEvent(navigation, {
    kind: 'fail',
    error: { code: 'navigation_failed', message: 'boom', retryable: false },
  });
  assert.equal(navigation.phase, 'failed');
  assert.equal(navigation.error?.code, 'navigation_failed');
  assert.equal(navigation.error?.message, 'boom');
});

test('terminal phases ignore further events', () => {
  let navigation = createNavigation(1, 'https://example.com/', 'https://example.com');
  navigation = applyNavigationEvent(navigation, {
    kind: 'fail',
    error: { code: 'navigation_failed', message: 'boom', retryable: false },
  });
  const afterFail = applyNavigationEvent(navigation, { kind: 'document.ready', readyState: 'complete' });
  // failed stays failed
  assert.equal(afterFail.phase, 'failed');
  assert.equal(afterFail.readyState, undefined);
});

test('default readiness policy requires a non-loading document', () => {
  assert.equal(
    defaultPageReadinessPolicy({ readyState: 'loading', now: 0 }),
    false,
  );
  assert.equal(
    defaultPageReadinessPolicy({ readyState: 'interactive', textLength: 200, textRevision: 1, now: 0 }),
    true,
  );
});

test('default readiness policy blocks until a body text sample exists', () => {
  // The volcengine scenario: document complete but body text has never been
  // sampled. Declaring readiness here would return only the page shell.
  assert.equal(
    defaultPageReadinessPolicy({ readyState: 'complete', now: 0 }),
    false,
  );
  // Even with network quiesced, no text sample => not readable.
  assert.equal(
    defaultPageReadinessPolicy({
      readyState: 'complete',
      inflightRequests: 0,
      lastNetworkActivityAt: 1_000,
      now: 1_000 + SETTLING_WINDOW_MS + 100,
    }),
    false,
  );
});

test('default readiness policy does not block on empty body while a shell renders', () => {
  // shell first, body later
  assert.equal(
    defaultPageReadinessPolicy({ readyState: 'complete', textLength: 0, now: 0 }),
    false,
  );
  assert.equal(
    defaultPageReadinessPolicy({ readyState: 'complete', textLength: 400, textRevision: 3, now: 0 }),
    true,
  );
});

test('default readiness policy treats long websocket connections as non-blocking', () => {
  // inflight is 0 (websocket not counted) → readiness not blocked by network
  assert.equal(
    defaultPageReadinessPolicy({
      readyState: 'complete',
      textLength: 900,
      textRevision: 4,
      inflightRequests: 0,
      lastNetworkActivityAt: 1_000,
      now: 1_000 + SETTLING_WINDOW_MS + 100,
    }),
    true,
  );
});

test('default readiness policy blocks while inflight requests are pending', () => {
  assert.equal(
    defaultPageReadinessPolicy({
      readyState: 'complete',
      textLength: 500,
      textRevision: 2,
      inflightRequests: 3,
      lastNetworkActivityAt: 0,
      now: 10_000,
    }),
    false,
  );
});

test('a full SPA-like lifecycle settles through settling to readable', () => {
  // Simulate: shell renders first, body hydrates after load, network quiets.
  let navigation = createNavigation(1, 'https://app.example/', 'https://app.example');

  navigation = applyNavigationEvent(navigation, { kind: 'commit', url: 'https://app.example/' });
  navigation = applyNavigationEvent(navigation, { kind: 'document.ready', readyState: 'complete' });

  // Shell only, no body text yet → policy says not readable.
  navigation = applyNavigationEvent(navigation, { kind: 'dom', textLength: 0, textRevision: 1, now: 100 });
  navigation = applyNavigationEvent(
    navigation,
    { kind: 'settle_verdict', readable: defaultPageReadinessPolicy({
      readyState: navigation.readyState, inflightRequests: 2, textLength: 0, textRevision: 1, lastNetworkActivityAt: 100, now: 110,
    }), now: 110 },
  );
  assert.notEqual(navigation.phase, 'readable');

  // Body hydrates, network quiet for the settling window → readable.
  navigation = applyNavigationEvent(navigation, { kind: 'dom', textLength: 5000, textRevision: 5, now: 400 });
  const quiet = applyNavigationEvent(
    navigation,
    { kind: 'settle_verdict', readable: defaultPageReadinessPolicy({
      readyState: navigation.readyState, inflightRequests: 0, textLength: 5000, textRevision: 5, lastNetworkActivityAt: 400, now: 400 + SETTLING_WINDOW_MS + 10,
    }), now: 400 + SETTLING_WINDOW_MS + 10 },
  );
  assert.equal(quiet.phase, 'readable');
});

test('a dom event tracks DOM activity separately from network activity', () => {
  let navigation = createNavigation(1, 'https://app.example/', 'https://app.example');
  navigation = applyNavigationEvent(navigation, { kind: 'commit', url: 'https://app.example/' });
  navigation = applyNavigationEvent(navigation, { kind: 'document.ready', readyState: 'complete' });
  // Network activity baselines at t=1000 (inflight > 0 sets lastNetworkActivityAt).
  navigation = applyNavigationEvent(navigation, { kind: 'network', inflightRequests: 1, now: 800 });
  navigation = applyNavigationEvent(navigation, { kind: 'network', inflightRequests: 0, now: 1_000 });

  // DOM churn (ticking clock / carousel) keeps revising text but must not
  // re-arm the network settle window.
  navigation = applyNavigationEvent(navigation, { kind: 'dom', textLength: 300, textRevision: 2, now: 1_100 });
  navigation = applyNavigationEvent(navigation, { kind: 'dom', textLength: 320, textRevision: 3, now: 1_200 });

  // lastNetworkActivityAt is the last *network* activity (inflight went to 0 at
  // t=1000, so lastNetworkActivityAt holds the 800 from the inflight>0 sample);
  // the DOM events at 1_100/1_200 must not have moved it.
  assert.equal(navigation.lastDomActivityAt, 1_200);
  assert.equal(navigation.lastNetworkActivityAt, 800);

  // Readiness only needs the *network* quiet window; recent DOM churn does not
  // block settle. Network was quiet since 800 and we poll later.
  const ready = defaultPageReadinessPolicy({
    readyState: navigation.readyState,
    inflightRequests: navigation.inflightRequests,
    textLength: navigation.textLength,
    textRevision: navigation.textRevision,
    lastNetworkActivityAt: navigation.lastNetworkActivityAt,
    lastDomActivityAt: navigation.lastDomActivityAt,
    now: 800 + SETTLING_WINDOW_MS + 10,
  });
  assert.equal(ready, true);

  // Provide the DOM field in a settle verdict: the resulting phase is readable.
  navigation = applyNavigationEvent(
    navigation,
    { kind: 'settle_verdict', readable: ready, now: 800 + SETTLING_WINDOW_MS + 10 },
  );
  assert.equal(navigation.phase, 'readable');
});

test('a cross-origin commit is rejected with an origin_changed failure', () => {
  let navigation = createNavigation(1, 'https://example.com/', 'https://example.com');
  navigation = applyNavigationEvent(navigation, {
    kind: 'commit',
    url: 'https://attacker.test/steal',
  });
  assert.equal(navigation.phase, 'failed');
  assert.equal(navigation.error?.code, 'origin_changed');
  assert.equal(navigation.error?.retryable, false);
  assert.equal(navigation.committedUrl, undefined);
});

test('an origin-changed failure is terminal', () => {
  let navigation = createNavigation(1, 'https://example.com/', 'https://example.com');
  navigation = applyNavigationEvent(navigation, {
    kind: 'commit',
    url: 'https://attacker.test/',
  });
  const after = applyNavigationEvent(navigation, {
    kind: 'commit',
    url: 'https://example.com/',
  });
  assert.equal(after.phase, 'failed');
});

test('approved origin is normalized so trailing slashes and case are symmetric', () => {
  // Caller passes the requested URL directly as approvedOrigin (`https://x.com/`,
  // uppercase scheme) — the natural thing since it doubles as the requested URL.
  let navigation = createNavigation(1, 'HTTPS://X.COM/', 'HTTPS://X.COM/');
  navigation = applyNavigationEvent(navigation, { kind: 'commit', url: 'https://x.com/foo' });
  assert.equal(navigation.phase, 'committed');
  assert.equal(navigation.committedUrl, 'https://x.com/foo');

  // Default port collapsed on both sides.
  navigation = applyNavigationEvent(navigation, { kind: 'commit', url: 'https://x.com:443/bar' });
  assert.equal(navigation.phase, 'committed');
});

test('an http→https scheme upgrade on the same host is same-origin', () => {
  // The volcengine target in the issue sits behind an http→https upgrade.
  let navigation = createNavigation(1, 'http://volcengine.com/', 'http://volcengine.com');
  navigation = applyNavigationEvent(navigation, { kind: 'commit', url: 'https://volcengine.com/' });
  assert.equal(navigation.phase, 'committed');
  assert.equal(navigation.committedUrl, 'https://volcengine.com/');
});

test('www and apex hosts are treated as the same host family', () => {
  let navigation = createNavigation(1, 'https://volcengine.com/', 'https://volcengine.com');
  navigation = applyNavigationEvent(navigation, {
    kind: 'commit',
    url: 'https://www.volcengine.com/page',
  });
  assert.equal(navigation.phase, 'committed');

  // Reverse direction: approved with www, commits to the apex host.
  navigation = createNavigation(1, 'https://www.example.com/', 'https://www.example.com');
  navigation = applyNavigationEvent(navigation, { kind: 'commit', url: 'https://example.com/' });
  assert.equal(navigation.phase, 'committed');
});

test('an https→http downgrade on the same host is rejected', () => {
  let navigation = createNavigation(1, 'https://x.com/', 'https://x.com');
  navigation = applyNavigationEvent(navigation, { kind: 'commit', url: 'http://x.com/' });
  assert.equal(navigation.phase, 'failed');
  assert.equal(navigation.error?.code, 'origin_changed');
  assert.equal(navigation.error?.retryable, false);
});

test('a different effective port is rejected', () => {
  let navigation = createNavigation(1, 'https://x.com/', 'https://x.com');
  navigation = applyNavigationEvent(navigation, { kind: 'commit', url: 'https://x.com:8080/' });
  assert.equal(navigation.phase, 'failed');
  assert.equal(navigation.error?.code, 'origin_changed');
});

test('an intermediate about:blank commit is ignored, not fatal', () => {
  // Chrome commits about:blank as an intermediate step while a real navigation
  // is in flight; it must neither fail the navigation nor advance the phase.
  let navigation = createNavigation(1, 'https://example.com/', 'https://example.com');
  const before = applyNavigationEvent(navigation, {
    kind: 'commit',
    url: 'about:blank',
  });
  assert.equal(before.phase, 'requested');
  assert.equal(before.committedUrl, undefined);
  assert.equal(before.error, undefined);

  // The real (http/s) commit still lands afterwards.
  const after = applyNavigationEvent(before, { kind: 'commit', url: 'https://example.com/' });
  assert.equal(after.phase, 'committed');
  assert.equal(after.committedUrl, 'https://example.com/');
});

test('intermediate non-http(s) commits do not fail a readable re-entry either', () => {
  let navigation = createNavigation(1, 'https://app.example/a', 'https://app.example');
  navigation = applyNavigationEvent(navigation, { kind: 'commit', url: 'https://app.example/a' });
  navigation = applyNavigationEvent(navigation, { kind: 'document.ready', readyState: 'complete' });
  navigation = applyNavigationEvent(navigation, { kind: 'dom', textLength: 1000, textRevision: 1, now: 100 });
  navigation = applyNavigationEvent(
    navigation,
    { kind: 'settle_verdict', readable: true, now: 100 + SETTLING_WINDOW_MS + 10 },
  );
  assert.equal(navigation.phase, 'readable');

  // A transient about:blank during a client-side route change is ignored and
  // the readable state is preserved until the real next commit.
  const after = applyNavigationEvent(navigation, { kind: 'commit', url: 'about:blank' });
  assert.equal(after.phase, 'readable');
  assert.equal(after.committedUrl, 'https://app.example/a');
});

test('settling keeps tracking activity instead of freezing the baseline', () => {
  let navigation = createNavigation(1, 'https://example.com/', 'https://example.com');
  navigation = applyNavigationEvent(navigation, { kind: 'commit', url: 'https://example.com/' });
  navigation = applyNavigationEvent(navigation, { kind: 'document.ready', readyState: 'complete' });
  navigation = applyNavigationEvent(navigation, { kind: 'dom', textLength: 200, textRevision: 1, now: 100 });

  // First false verdict moves dom_ready → settling, baselining activity at t=100.
  navigation = applyNavigationEvent(
    navigation,
    { kind: 'settle_verdict', readable: false, now: 100 },
  );
  assert.equal(navigation.phase, 'settling');
  assert.equal(navigation.lastNetworkActivityAt, 100);

  // A later false verdict (activity still observed at t=400) must track the new
  // observation rather than freeze lastNetworkActivityAt at 100.
  navigation = applyNavigationEvent(
    navigation,
    { kind: 'settle_verdict', readable: false, now: 400 },
  );
  assert.equal(navigation.phase, 'settling');
  assert.equal(navigation.lastNetworkActivityAt, 400);
});

test('a readable navigation re-enters on a new commit (SPA route change)', () => {
  let navigation = createNavigation(1, 'https://app.example/a', 'https://app.example');
  navigation = applyNavigationEvent(navigation, { kind: 'commit', url: 'https://app.example/a' });
  navigation = applyNavigationEvent(navigation, { kind: 'document.ready', readyState: 'complete' });
  navigation = applyNavigationEvent(navigation, { kind: 'dom', textLength: 1000, textRevision: 1, now: 100 });
  navigation = applyNavigationEvent(
    navigation,
    { kind: 'settle_verdict', readable: true, now: 100 + SETTLING_WINDOW_MS + 10 },
  );
  assert.equal(navigation.phase, 'readable');

  // Client-side route change to a same-origin URL re-enters the lifecycle and
  // re-arms readiness tracking for the new document.
  navigation = applyNavigationEvent(navigation, {
    kind: 'commit',
    url: 'https://app.example/b',
  });
  assert.equal(navigation.phase, 'committed');
  assert.equal(navigation.committedUrl, 'https://app.example/b');
  // Readiness fields were reset for the new page.
  assert.equal(navigation.readyState, undefined);
  assert.equal(navigation.textLength, undefined);
});

test('a readable navigation ignores non-commit events until a new commit', () => {
  let navigation = createNavigation(1, 'https://app.example/a', 'https://app.example');
  navigation = applyNavigationEvent(navigation, { kind: 'commit', url: 'https://app.example/a' });
  navigation = applyNavigationEvent(navigation, { kind: 'document.ready', readyState: 'complete' });
  navigation = applyNavigationEvent(navigation, { kind: 'dom', textLength: 1000, textRevision: 1, now: 100 });
  navigation = applyNavigationEvent(
    navigation,
    { kind: 'settle_verdict', readable: true, now: 100 + SETTLING_WINDOW_MS + 10 },
  );
  assert.equal(navigation.phase, 'readable');

  const after = applyNavigationEvent(navigation, { kind: 'network', inflightRequests: 5, now: 500 });
  assert.equal(after.phase, 'readable');
  assert.equal(after.inflightRequests, undefined);
});
