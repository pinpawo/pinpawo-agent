import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { ChromeExtensionBrowserSession } from './session';
import { BrowserBridgeError, type BrowserBridgeStatus } from './bridge';
import { BrowserOperationError } from '../../errors';
import type { BrowserRuntimeEvent } from '../../lifecycle/events';

const rawTree = '- text: "Readable page"\n- button "Continue" [ref=snapshot-1:1]';
const rawSnapshot = {
  title: 'Example',
  url: 'https://example.com/page',
  tree: rawTree,
  treeLength: rawTree.length,
  refCount: 1,
  source: 'accessibility',
};

test('extension session uses one approved origin and the shared payload builder', async () => {
  const calls: Array<{
    command: string;
    params: Record<string, unknown>;
    signal: AbortSignal | undefined;
  }> = [];
  const session = new ChromeExtensionBrowserSession({
    async sendCommand(command, params, _timeoutMs, signal) {
      calls.push({ command, params, signal });
      if (command === 'detach') return { detached: true };
      if (command === 'navigate') return { ok: true };
      return rawSnapshot;
    },
  });

  const opened = JSON.parse(await session.open('https://example.com/page')) as {
    tree: string;
    refCount: number;
  };
  assert.equal(opened.tree, rawTree);
  assert.equal(opened.refCount, 1);
  assert.deepEqual(calls[0], {
    command: 'navigate',
    params: {
      url: 'https://example.com/page',
      approvedOrigin: 'https://example.com',
    },
    signal: undefined,
  });
  // Issue #601: navigate is fire-and-forget; the backward-compatible path
  // takes a snapshot after navigate, so calls[1] is the snapshot from open().
  assert.equal(calls[1]?.command, 'snapshot');

  const controller = new AbortController();
  await session.snapshot(controller.signal);
  assert.deepEqual(calls[2], {
    command: 'snapshot',
    params: { approvedOrigin: 'https://example.com' },
    signal: controller.signal,
  });
  await session.close();
  assert.equal(calls[3]?.command, 'detach');
});

test('extension session reserves navigation generation before dispatching navigate', async () => {
  const sequence: string[] = [];
  const session = new ChromeExtensionBrowserSession({
    getStatus() {
      return {
        listening: true,
        hostConnected: true,
        extensionConnected: true,
        debuggerAttached: true,
        targetAlive: true,
        connectionId: 'connection-1',
        extensionId: 'extension-1',
        activeTabId: 7,
        activeTabBinding: 'agent',
        userBoundOrigin: null,
        stateRevision: 1,
        capabilities: [],
        socketPath: '/tmp/browser.sock',
        connectionGeneration: 1,
        targetGeneration: 1,
        navigationGeneration: 3,
      } as BrowserBridgeStatus;
    },
    beginNavigation() {
      sequence.push('generation');
      return 4;
    },
    async sendCommand(command, _params, _timeoutMs, _signal, options) {
      sequence.push(`send:${command}:${String(options?.beginNavigation)}`);
      return command === 'navigate' ? { ok: true } : rawSnapshot;
    },
  });

  await session.open('https://example.com/page');
  assert.deepEqual(sequence, [
    'generation',
    'send:navigate:false',
    'send:snapshot:undefined',
  ]);
});

test('extension navigation timeout keeps the approved origin for browser_wait', async () => {
  const calls: Array<{ command: string; params: Record<string, unknown> }> = [];
  const session = new ChromeExtensionBrowserSession({
    async sendCommand(command, params) {
      calls.push({ command, params });
      if (command === 'navigate') {
        throw new BrowserBridgeError('navigation_timeout', 'page still loading', true);
      }
      return rawSnapshot;
    },
  });

  await assert.rejects(
    session.open('https://example.com/page'),
    (error: unknown) => error instanceof BrowserBridgeError
      && error.code === 'navigation_timeout',
  );
  await session.wait();
  assert.deepEqual(calls[1], {
    command: 'wait',
    params: {
      approvedOrigin: 'https://example.com',
      timeoutMs: 3_000,
      state: 'visible',
    },
  });
});

test('extension session rejects non-http targets and requires an approved page for actions', async () => {
  const session = new ChromeExtensionBrowserSession({
    async sendCommand() {
      return rawSnapshot;
    },
  });
  await assert.rejects(session.open('file:///tmp/page.html'), /only supports http/);
  await assert.rejects(session.click('#submit'), /Use browser_open first/);
});

test('a user-bound tab in the bridge status never becomes a session\'s approved origin', async () => {
  // The bridge status reports whichever browser context the extension
  // activated last. A user-bound tab lives in the extension's legacy context,
  // so it must not leak into an Agent session's approval (verified in real
  // Chrome: binding a tab made another session's snapshot fail with
  // origin_changed against the user's origin).
  const calls: Array<{ command: string; params: Record<string, unknown> }> = [];
  let userBoundOrigin: string | null = 'https://user.example';
  const session = new ChromeExtensionBrowserSession({
    getStatus() {
      return {
        activeTabBinding: userBoundOrigin ? 'user' : 'agent',
        userBoundOrigin,
      } as BrowserBridgeStatus;
    },
    async sendCommand(command, params) {
      calls.push({ command, params });
      if (command === 'navigate') return { ok: true };
      const approvedOrigin = String(params.approvedOrigin);
      return { ...rawSnapshot, url: `${approvedOrigin}/page` };
    },
  });

  await assert.rejects(session.snapshot(), /No approved Chrome extension page\. Use browser_open first\./);
  assert.equal(calls.length, 0);

  await session.open('https://agent.example/page');
  await session.snapshot();
  userBoundOrigin = null;
  await session.snapshot();

  assert.deepEqual(calls.map((call) => call.params.approvedOrigin), [
    'https://agent.example', // navigate
    'https://agent.example', // snapshot from open() backward-compat path
    'https://agent.example',
    'https://agent.example',
  ]);
});

test('extension session maps P1 interactions and normalizes extract and screenshot results', async () => {
  const calls: Array<{ command: string; params: Record<string, unknown> }> = [];
  const workdir = await mkdtemp(resolve(tmpdir(), 'pinpawo-browser-p1-'));
  const session = new ChromeExtensionBrowserSession({
    async sendCommand(command, params) {
      calls.push({ command, params });
      if (command === 'navigate') return { ok: true };
      if (command === 'extract') {
        return {
          title: 'Example',
          url: 'https://example.com/page',
          selector: undefined,
          text: 'page',
          textLength: 9,
          offset: 0,
          limit: 4,
          textSource: 'document.body.innerText',
        };
      }
      if (command === 'screenshot') {
        return { mimeType: 'image/jpeg', data: 'AQ==' };
      }
      return rawSnapshot;
    },
  }, () => workdir);

  await session.open('https://example.com/page');
  await session.click({ ref: 'snapshot-1:1' });
  await session.type({ selector: '#name' }, 'PinPawo', true);
  await session.scroll({ deltaY: 480 });
  await session.wait({ selector: '#ready' }, 2_000, 'hidden');
  const extracted = JSON.parse(await session.extract({ offset: 0, limit: 4 })) as {
    text: string;
    hasMore: boolean;
    nextOffset: number;
  };
  const screenshot = JSON.parse(await session.screenshot()) as { path: string; byteLength: number };

  assert.equal(extracted.text, 'page');
  assert.equal(extracted.hasMore, true);
  assert.equal(extracted.nextOffset, 4);
  assert.equal(screenshot.byteLength, 1);
  assert.match(screenshot.path, /\.pinpawo\/browser\/screenshots\/.*\.jpg$/);
  // Issue #601: navigate is fire-and-forget; the backward-compat path adds
  // a snapshot call after navigate, so command indices shift by 1.
  assert.deepEqual(calls.slice(2, 6).map((call) => call.command), [
    'click',
    'type',
    'scroll',
    'wait',
  ]);
  assert.deepEqual(calls[2]?.params.target, { selector: undefined, ref: 'snapshot-1:1' });
  assert.deepEqual(calls[5]?.params, {
    approvedOrigin: 'https://example.com',
    timeoutMs: 2_000,
    state: 'hidden',
    target: { selector: '#ready', ref: undefined },
  });
});

test('extension session rejects raw snapshots outside the approved origin', async () => {
  const session = new ChromeExtensionBrowserSession({
    async sendCommand(command) {
      if (command === 'navigate') return { ok: true };
      return {
        ...rawSnapshot,
        url: 'https://unapproved.example/private',
      };
    },
  });

  await assert.rejects(
    session.open('https://example.com/page'),
    (error: unknown) => error instanceof BrowserBridgeError
      && error.code === 'origin_changed'
      && error.details?.actualOrigin === 'https://unapproved.example',
  );
  await assert.rejects(session.snapshot(), /Use browser_open first/);
});

test('extension session preserves long browser_type input and budgets enough driver time', async () => {
  const calls: Array<{
    command: string;
    params: Record<string, unknown>;
    timeoutMs: number | undefined;
  }> = [];
  const session = new ChromeExtensionBrowserSession({
    async sendCommand(command, params, timeoutMs) {
      calls.push({ command, params, timeoutMs });
      if (command === 'navigate') return { ok: true };
      return rawSnapshot;
    },
  });
  const text = '🙂'.repeat(4_001);

  await session.open('https://example.com/page');
  await session.type('#message', text);

  // Issue #601: navigate is fire-and-forget; backward-compat path adds snapshot
  // at calls[1], so the type command is at calls[2].
  assert.equal(calls[2]?.params.text, text);
  assert.ok((calls[2]?.timeoutMs ?? 0) > 30_000);
});

test('extension session drives browser_open through the readiness state machine to readable', async () => {
  const listeners: Array<(event: BrowserRuntimeEvent) => void> = [];
  const status = {
    listening: true,
    hostConnected: true,
    extensionConnected: true,
    debuggerAttached: true,
    targetAlive: true,
    connectionId: 'conn-1',
    extensionId: 'ext-1',
    activeTabId: 7,
    activeTabBinding: 'agent',
    userBoundOrigin: null,
    stateRevision: 1,
    capabilities: [],
    socketPath: '/tmp/browser.sock',
    connectionGeneration: 1,
    targetGeneration: 1,
    navigationGeneration: 1,
  } as BrowserBridgeStatus;
  const gen = { connectionGeneration: 1, targetGeneration: 1 };

  const session = new ChromeExtensionBrowserSession({
    getStatus() {
      return status;
    },
    onRuntimeEvent(listener) {
      listeners.push(listener);
      return () => {};
    },
    onGenerationChanged(listener) {
      listener(gen);
      return () => {};
    },
    async sendCommand(command, params) {
      if (command === 'navigate') {
        // Simulate the real bridge (#603 M1): dispatching `navigate` bumps the
        // navigation generation, and live events arrive *after* the command
        // returns (async, via the bridge), i.e. after the session binds the
        // post-navigate generation. If the session bind the pre-navigate
        // generation (the bug), every event would be dropped as stale and
        // `browser_open` would time out.
        const gen = (status.navigationGeneration ?? 0) + 1;
        status.navigationGeneration = gen;
        setImmediate(() => {
          const past = Date.now() - 500;
          const base = {
            tabId: 7,
            timestamp: past,
            connectionGeneration: 1,
            targetGeneration: 1,
            navigationGeneration: gen,
          };
          listeners.forEach((l) => l({
            ...base,
            type: 'navigation.committed',
            url: String(params.url),
          }));
          listeners.forEach((l) => l({
            ...base,
            type: 'document.ready',
            payload: { readyState: 'complete' },
          }));
          listeners.forEach((l) => l({
            tabId: 7,
            timestamp: Date.now(),
            connectionGeneration: 1,
            targetGeneration: 1,
            navigationGeneration: gen,
            type: 'dom.changed',
            payload: { textLength: 42, textRevision: 1 },
          }));
        });
        return { ok: true };
      }
      return rawSnapshot;
    },
  });

  const opened = await session.open('https://example.com/page');
  assert.ok(/Readable page/.test(opened));
  // issue #583 review M2: the state machine must actually reach `readable`
  // (phase assertion), not merely any snapshot-returning outcome — the old
  // `/Readable page/` assertion held even when the navigation was stuck in
  // `settling` and `open()` fell through to `pending`.
  assert.equal(session.lastReadinessPhase, 'readable');
});

test('extension session surfaces a cross-origin readiness failure as origin_changed', async () => {
  const listeners: Array<(event: BrowserRuntimeEvent) => void> = [];
  const status = {
    activeTabId: 9,
    connectionGeneration: 1,
    targetGeneration: 1,
    navigationGeneration: 1,
  } as BrowserBridgeStatus;

  const session = new ChromeExtensionBrowserSession({
    getStatus() {
      return status;
    },
    onRuntimeEvent(listener) {
      listeners.push(listener);
      return () => {};
    },
    onGenerationChanged() {
      return () => {};
    },
    async sendCommand(command, params) {
      if (command === 'navigate') {
        // Simulate real bridge: navigation generation bumps on dispatch and
        // live events arrive after the navigate command returns (#603 M1).
        const gen = (status.navigationGeneration ?? 0) + 1;
        status.navigationGeneration = gen;
        setImmediate(() => {
          // Navigation commits to an attacker origin: the readiness state
          // machine must refuse it deterministically, not trust the returned
          // snapshot.
          listeners.forEach((l) => l({
            tabId: 9,
            timestamp: Date.now(),
            connectionGeneration: 1,
            targetGeneration: 1,
            navigationGeneration: gen,
            type: 'navigation.committed',
            url: 'https://attacker.example/steal',
          }));
        });
        return { ok: true };
      }
      return rawSnapshot;
    },
  });

  await assert.rejects(
    session.open('https://example.com/page'),
    (error: unknown) => error instanceof BrowserBridgeError
      && error.code === 'origin_changed'
      && error.details?.committedUrl === 'https://attacker.example/steal',
  );
});

test('extension session does NOT mark a text-less (SPA shell) navigation readable', async () => {
  const listeners: Array<(event: BrowserRuntimeEvent) => void> = [];
  const status = {
    activeTabId: 11,
    connectionGeneration: 1,
    targetGeneration: 1,
    navigationGeneration: 1,
  } as BrowserBridgeStatus;

  const session = new ChromeExtensionBrowserSession({
    async sendCommand(command, params) {
      if (command === 'navigate') {
        return { ok: true };
      }
      return rawSnapshot;
    },
  });

  // Do not throw: the backward-compatible path honors the returned snapshot
  // while the page is still hydrating. But the readiness verdict must NOT be
  // `readable` for an empty-body shell (the volcengine scenario).
  const opened = await session.open('https://example.com/page');
  assert.ok(/Readable page/.test(opened));
  assert.notEqual(session.lastReadinessPhase, 'readable');
});

test('extension session drives a click through the interaction settle state machine', async () => {
  const listeners: Array<(event: BrowserRuntimeEvent) => void> = [];
  const status = {
    activeTabId: 13,
    connectionGeneration: 1,
    targetGeneration: 1,
    navigationGeneration: 1,
  } as BrowserBridgeStatus;

  const session = new ChromeExtensionBrowserSession({
    getStatus() {
      return status;
    },
    onRuntimeEvent(listener) {
      listeners.push(listener);
      return () => {};
    },
    onGenerationChanged() {
      return () => {};
    },
    async sendCommand(command) {
      if (command === 'navigate') {
        // Simulate real bridge: navigation generation bumps on dispatch and
        // live events arrive after the navigate command returns (#603 M1).
        const gen = (status.navigationGeneration ?? 0) + 1;
        status.navigationGeneration = gen;
        setImmediate(() => {
          const past = Date.now() - 500;
          const base = { tabId: 13, timestamp: past, connectionGeneration: 1, targetGeneration: 1, navigationGeneration: gen };
          listeners.forEach((l) => l({ ...base, type: 'navigation.committed', url: 'https://example.com/page' }));
          listeners.forEach((l) => l({ ...base, type: 'document.ready', payload: { readyState: 'complete' } }));
          listeners.forEach((l) => l({ tabId: 13, timestamp: Date.now(), connectionGeneration: 1, targetGeneration: 1, navigationGeneration: gen, type: 'dom.changed', payload: { textLength: 42, textRevision: 1 } }));
        });
        return { ok: true };
      }
      if (command === 'snapshot') return rawSnapshot;
      if (command !== 'click') throw new Error(`unexpected command: ${String(command)}`);
      // The click produces a same-generation page that becomes readable: the
      // interaction settle driver must reach `settled` and return the snapshot.
      const base = { tabId: 13, timestamp: Date.now() };
      listeners.forEach((l) => l({
        ...base,
        connectionGeneration: 1,
        targetGeneration: 1,
        navigationGeneration: status.navigationGeneration,
        type: 'navigation.committed',
        url: 'https://example.com/',
      }));
      listeners.forEach((l) => l({
        ...base,
        connectionGeneration: 1,
        targetGeneration: 1,
        navigationGeneration: status.navigationGeneration,
        type: 'document.ready',
        payload: { readyState: 'complete' },
      }));
      listeners.forEach((l) => l({
        ...base,
        connectionGeneration: 1,
        targetGeneration: 1,
        navigationGeneration: status.navigationGeneration,
        type: 'dom.changed',
        payload: { textLength: 42, textRevision: 1 },
      }));
      return rawSnapshot;
    },
  });

  await session.open('https://example.com/page');
  const afterClick = await session.click({ ref: 'snapshot-1:1' });
  assert.ok(/Readable page/.test(afterClick));
  // S1: the interaction path must also record the phase it reached, so a later
  // debugger/instrumentation sees the post-action settle verdict rather than the
  // previous `open()` value.
  assert.equal(session.lastReadinessPhase, 'readable');
});

test('extension session surfaces a cross-origin interaction as origin_changed', async () => {
  const listeners: Array<(event: BrowserRuntimeEvent) => void> = [];
  const status = {
    activeTabId: 14,
    connectionGeneration: 1,
    targetGeneration: 1,
    navigationGeneration: 1,
  } as BrowserBridgeStatus;

  const session = new ChromeExtensionBrowserSession({
    getStatus() {
      return status;
    },
    onRuntimeEvent(listener) {
      listeners.push(listener);
      return () => {};
    },
    onGenerationChanged() {
      return () => {};
    },
    async sendCommand(command) {
      if (command === 'navigate') {
        // Simulate real bridge: navigation generation bumps on dispatch and
        // live events arrive after the navigate command returns (#603 M1).
        const gen = (status.navigationGeneration ?? 0) + 1;
        status.navigationGeneration = gen;
        setImmediate(() => {
          const past = Date.now() - 500;
          const base = { tabId: 14, timestamp: past, connectionGeneration: 1, targetGeneration: 1, navigationGeneration: gen };
          listeners.forEach((l) => l({ ...base, type: 'navigation.committed', url: 'https://example.com/page' }));
          listeners.forEach((l) => l({ ...base, type: 'document.ready', payload: { readyState: 'complete' } }));
          listeners.forEach((l) => l({ tabId: 14, timestamp: Date.now(), connectionGeneration: 1, targetGeneration: 1, navigationGeneration: gen, type: 'dom.changed', payload: { textLength: 42, textRevision: 1 } }));
        });
        return { ok: true };
      }
      if (command === 'snapshot') return rawSnapshot;
      if (command !== 'click') throw new Error(`unexpected command: ${String(command)}`);
      // The click navigates cross-origin: the settle state machine must refuse
      // it deterministically instead of trusting the returned snapshot.
      listeners.forEach((l) => l({
        tabId: 14,
        timestamp: Date.now(),
        connectionGeneration: 1,
        targetGeneration: 1,
        navigationGeneration: status.navigationGeneration,
        type: 'navigation.committed',
        url: 'https://attacker.example/steal',
      }));
      return rawSnapshot;
    },
  });

  await session.open('https://example.com/page');
  await assert.rejects(
    session.click({ ref: 'snapshot-1:1' }),
    (error: unknown) => error instanceof BrowserBridgeError
      && error.code === 'origin_changed'
      && error.details?.committedUrl === 'https://attacker.example/steal',
  );
});

test('extension session does NOT mark a text-less (SPA shell) click resolved readable', async () => {
  const listeners: Array<(event: BrowserRuntimeEvent) => void> = [];
  const status = {
    activeTabId: 15,
    connectionGeneration: 1,
    targetGeneration: 1,
    navigationGeneration: 1,
  } as BrowserBridgeStatus;

  const session = new ChromeExtensionBrowserSession({
    getStatus() {
      return status;
    },
    onRuntimeEvent(listener) {
      listeners.push(listener);
      return () => {};
    },
    onGenerationChanged() {
      return () => {};
    },
    async sendCommand(command) {
      if (command === 'navigate') {
        // Simulate real bridge: navigation generation bumps on dispatch and
        // live events arrive after the navigate command returns (#603 M1).
        const gen = (status.navigationGeneration ?? 0) + 1;
        status.navigationGeneration = gen;
        setImmediate(() => {
          const past = Date.now() - 500;
          const base = { tabId: 15, timestamp: past, connectionGeneration: 1, targetGeneration: 1, navigationGeneration: gen };
          listeners.forEach((l) => l({ ...base, type: 'navigation.committed', url: 'https://example.com/page' }));
          listeners.forEach((l) => l({ ...base, type: 'document.ready', payload: { readyState: 'complete' } }));
          listeners.forEach((l) => l({ tabId: 15, timestamp: Date.now(), connectionGeneration: 1, targetGeneration: 1, navigationGeneration: gen, type: 'dom.changed', payload: { textLength: 42, textRevision: 1 } }));
        });
        return { ok: true };
      }
      if (command === 'snapshot') return rawSnapshot;
      if (command !== 'click') throw new Error(`unexpected command: ${String(command)}`);
      // Click commits same-origin and the document is complete, but the body
      // text is empty → the settle driver must NOT reach `readable`.
      const base = { tabId: 15, timestamp: Date.now() };
      listeners.forEach((l) => l({
        ...base,
        connectionGeneration: 1,
        targetGeneration: 1,
        navigationGeneration: status.navigationGeneration,
        type: 'navigation.committed',
        url: 'https://example.com/',
      }));
      listeners.forEach((l) => l({
        ...base,
        connectionGeneration: 1,
        targetGeneration: 1,
        navigationGeneration: status.navigationGeneration,
        type: 'document.ready',
        payload: { readyState: 'complete' },
      }));
      listeners.forEach((l) => l({
        ...base,
        connectionGeneration: 1,
        targetGeneration: 1,
        navigationGeneration: status.navigationGeneration,
        type: 'dom.changed',
        payload: { textLength: 0, textRevision: 1 },
      }));
      return rawSnapshot;
    },
  });

  await session.open('https://example.com/page');
  // Backward compatible: honor the returned snapshot (pending), but the post-action
  // phase must reflect that the page never reached `readable` (S1 weak-assertion guard).
  const afterClick = await session.click({ ref: 'snapshot-1:1' });
  assert.ok(/Readable page/.test(afterClick));
  assert.notEqual(session.lastReadinessPhase, 'readable');
});

test('a readiness timeout still leaves the session owning the page for browser_wait', async () => {
  const status = {
    activeTabId: 11,
    connectionGeneration: 1,
    targetGeneration: 1,
    navigationGeneration: 1,
  } as BrowserBridgeStatus;

  const session = new ChromeExtensionBrowserSession({
    getStatus() {
      return status;
    },
    onRuntimeEvent() {
      return () => {};
    },
    onGenerationChanged() {
      return () => {};
    },
    async sendCommand(command) {
      // navigate is fire-and-forget; no readiness events ever arrive, so the
      // wait runs out its deadline.
      if (command === 'navigate') {
        (status as { navigationGeneration?: number }).navigationGeneration = 2;
        return { ok: true, tabId: 11, url: 'https://example.com/slow' };
      }
      return rawSnapshot;
    },
  }, () => '/tmp');

  await assert.rejects(
    () => (session as unknown as {
      openAndAwaitReadiness(
        url: string,
        approvedOrigin: string,
        signal?: AbortSignal,
        deadlineMs?: number,
      ): Promise<string>;
    }).openAndAwaitReadiness('https://example.com/slow', 'https://example.com', undefined, 30),
    (error: unknown) => (error as { code?: string }).code === 'navigation_timeout',
  );

  // The page is loading, so the session owns it: a follow-up `browser_wait`
  // must not fail with `browser_not_open`, which is exactly what the timeout
  // message tells the caller to do next.
  assert.equal(
    (session as unknown as { approvedOrigin: string | null }).approvedOrigin,
    'https://example.com',
  );
});

test('a performed interaction whose page does not settle in time returns its snapshot, not a retryable error (#869)', async (t) => {
  const listeners: Array<(event: BrowserRuntimeEvent) => void> = [];
  const status = {
    activeTabId: 15,
    connectionGeneration: 1,
    targetGeneration: 1,
    navigationGeneration: 1,
  } as BrowserBridgeStatus;
  // Long humanized typing outlasts the settle deadline: the command itself
  // returns only after the deadline has passed.
  const realNow = Date.now.bind(Date);
  let elapsed = 0;
  t.mock.method(Date, 'now', () => realNow() + elapsed);

  const session = new ChromeExtensionBrowserSession({
    getStatus() {
      return status;
    },
    onRuntimeEvent(listener) {
      listeners.push(listener);
      return () => {};
    },
    onGenerationChanged() {
      return () => {};
    },
    async sendCommand(command) {
      if (command === 'navigate') {
        const gen = (status.navigationGeneration ?? 0) + 1;
        status.navigationGeneration = gen;
        setImmediate(() => {
          const base = { tabId: 15, timestamp: Date.now() - 500, connectionGeneration: 1, targetGeneration: 1, navigationGeneration: gen };
          listeners.forEach((l) => l({ ...base, type: 'navigation.committed', url: 'https://example.com/page' }));
          listeners.forEach((l) => l({ ...base, type: 'document.ready', payload: { readyState: 'complete' } }));
          listeners.forEach((l) => l({ ...base, timestamp: Date.now(), type: 'dom.changed', payload: { textLength: 42, textRevision: 1 } }));
        });
        return { ok: true };
      }
      if (command === 'snapshot') return rawSnapshot;
      if (command !== 'type') throw new Error(`unexpected command: ${String(command)}`);
      elapsed += 31_000;
      listeners.forEach((l) => l({
        tabId: 15,
        timestamp: Date.now(),
        connectionGeneration: 1,
        targetGeneration: 1,
        navigationGeneration: status.navigationGeneration,
        type: 'dom.changed',
        payload: { textLength: 0, textRevision: 2 },
      }));
      return rawSnapshot;
    },
  });

  await session.open('https://example.com/page');
  const result = JSON.parse(await session.type({ ref: 'snapshot-1:1' }, 'x'.repeat(200)));
  assert.equal(result.url, 'https://example.com/page');
  assert.equal(result.settle.settled, false);
  assert.match(result.settle.note, /type was performed/);
  assert.match(result.settle.note, /Do not repeat the type/);
});

test('element and full-page screenshots pass their scope and report truncation (#873)', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const workdir = await mkdtemp(resolve(tmpdir(), 'pinpawo-browser-shot-scope-'));
  let reply: Record<string, unknown> = {};
  const session = new ChromeExtensionBrowserSession({
    async sendCommand(command, params) {
      if (command === 'navigate') return { ok: true };
      if (command === 'screenshot') {
        calls.push(params);
        return { mimeType: 'image/jpeg', data: 'AQ==', ...reply };
      }
      return rawSnapshot;
    },
  }, () => workdir);
  await session.open('https://example.com/page');

  reply = { scope: 'element' };
  const element = JSON.parse(await session.screenshot(undefined, undefined, { target: { ref: 's:3' } }));
  assert.equal(element.scope, 'element');
  assert.deepEqual(calls[0], {
    approvedOrigin: 'https://example.com',
    target: { selector: undefined, ref: 's:3' },
  });

  reply = { scope: 'fullPage', truncated: { capturedHeight: 8000, regionHeight: 12000.4 } };
  const fullPage = JSON.parse(await session.screenshot(undefined, undefined, { fullPage: true }));
  assert.deepEqual(calls[1], { approvedOrigin: 'https://example.com', fullPage: true });
  assert.equal(fullPage.scope, 'fullPage');
  assert.equal(fullPage.truncated.capturedHeight, 8000);
  assert.equal(fullPage.truncated.regionHeight, 12000);
  assert.match(fullPage.truncated.note, /Only the top part/);

  reply = {};
  const viewport = JSON.parse(await session.screenshot());
  assert.deepEqual(calls[2], { approvedOrigin: 'https://example.com' });
  assert.equal(viewport.scope, 'viewport');
});

test('an extension that ignores the screenshot scope is reported, not passed off as the region (#873)', async () => {
  const session = new ChromeExtensionBrowserSession({
    async sendCommand(command) {
      if (command === 'navigate') return { ok: true };
      // An extension built before #873 returns a viewport image without a scope.
      if (command === 'screenshot') return { mimeType: 'image/jpeg', data: 'AQ==' };
      return rawSnapshot;
    },
  }, () => '/tmp');
  await session.open('https://example.com/page');

  await assert.rejects(
    session.screenshot(undefined, undefined, { fullPage: true }),
    (error: unknown) => error instanceof BrowserOperationError
      && error.code === 'browser_extension_outdated'
      && /Reload the PinPawo extension/.test(error.message),
  );
  await assert.rejects(
    session.screenshot(undefined, undefined, { fullPage: true, target: { ref: 's:1' } }),
    (error: unknown) => error instanceof BrowserOperationError
      && error.code === 'invalid_screenshot_options',
  );
});

test('an extension that still returns the pre-#873 snapshot format is reported as outdated', async () => {
  const session = new ChromeExtensionBrowserSession({
    async sendCommand(command) {
      if (command === 'navigate') return { ok: true };
      return { title: 'Example', url: 'https://example.com/page', text: 'Readable page', interactive: [] };
    },
  }, () => '/tmp');

  await assert.rejects(
    session.open('https://example.com/page'),
    (error: unknown) => error instanceof BrowserOperationError
      && error.code === 'browser_extension_outdated'
      && /Reload the PinPawo extension/.test(error.message),
  );
});

test('snapshot options reach the extension, and an extension ignoring them is reported (#873 3b)', async () => {
  const sent: Array<Record<string, unknown>> = [];
  let applied = true;
  const session = new ChromeExtensionBrowserSession({
    async sendCommand(command, params) {
      if (command === 'navigate') return { ok: true };
      if (command === 'snapshot') sent.push(params);
      return applied ? { ...rawSnapshot, applied: {} } : rawSnapshot;
    },
  }, () => '/tmp');
  await session.open('https://example.com/page');
  sent.length = 0;

  await session.snapshot(undefined, { target: { ref: 'ax:6A1F0C3E:5:navigation' }, depth: 2, interactiveOnly: true });
  await session.snapshot();
  assert.deepEqual(sent, [
    {
      approvedOrigin: 'https://example.com',
      target: { selector: undefined, ref: 'ax:6A1F0C3E:5:navigation' },
      depth: 2,
      interactiveOnly: true,
    },
    { approvedOrigin: 'https://example.com' },
  ]);

  applied = false;
  await session.snapshot();
  await assert.rejects(
    session.snapshot(undefined, { depth: 1 }),
    (error: unknown) => error instanceof BrowserOperationError
      && error.code === 'browser_extension_outdated',
  );
});

test('a tab the user handed to this session is its current page, announced once (#867)', async () => {
  const sent: string[] = [];
  let current: { tabId: number; binding: 'agent' | 'user'; userBoundOrigin?: string } | null = {
    tabId: 42,
    binding: 'user',
    userBoundOrigin: 'https://mail.example',
  };
  const session = new ChromeExtensionBrowserSession({
    async sendCommand(command, params) {
      sent.push(String(params.approvedOrigin));
      if (command === 'navigate') return { ok: true };
      return { ...rawSnapshot, url: `${String(params.approvedOrigin)}/inbox` };
    },
    contextTarget: () => current,
  }, () => '/tmp');

  // No browser_open: the hand-off alone makes the session usable.
  const first = JSON.parse(await session.snapshot()) as { url: string; handoff?: string };
  assert.equal(first.url, 'https://mail.example/inbox');
  assert.match(String(first.handoff), /dragging it into its PinPawo tab group/);
  const second = JSON.parse(await session.snapshot()) as { handoff?: string };
  assert.equal(second.handoff, undefined);

  // An agent tab as current falls back to the session's own approval.
  await session.open('https://agent.example/page');
  current = { tabId: 9, binding: 'agent' };
  await session.snapshot();
  assert.equal(sent.at(-1), 'https://agent.example');

  // Without a hand-off or an open there is still no page.
  const fresh = new ChromeExtensionBrowserSession({
    async sendCommand() { return rawSnapshot; },
    contextTarget: () => null,
  }, () => '/tmp');
  await assert.rejects(fresh.snapshot(), /Use browser_open first/);
});
