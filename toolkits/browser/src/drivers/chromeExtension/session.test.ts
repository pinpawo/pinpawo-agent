import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { ChromeExtensionBrowserSession } from './session';
import { BrowserBridgeError, type BrowserBridgeStatus } from './bridge';

const rawSnapshot = {
  title: 'Example',
  url: 'https://example.com/page',
  text: 'Readable page',
  interactive: [{
    index: 1,
    ref: 'snapshot-1:1',
    tag: 'button',
    text: 'Continue',
    type: null,
    placeholder: null,
    hint: 'button',
  }],
  interactiveCount: 1,
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
      return rawSnapshot;
    },
  });

  const opened = JSON.parse(await session.open('https://example.com/page')) as {
    text: string;
    interactive: Array<{ hint: string }>;
  };
  assert.equal(opened.text, 'Readable page');
  assert.equal(opened.interactive[0]?.hint, '[1] button');
  assert.deepEqual(calls[0], {
    command: 'navigate',
    params: { url: 'https://example.com/page', approvedOrigin: 'https://example.com' },
    signal: undefined,
  });

  const controller = new AbortController();
  await session.snapshot(controller.signal);
  assert.deepEqual(calls[1], {
    command: 'snapshot',
    params: { approvedOrigin: 'https://example.com' },
    signal: controller.signal,
  });
  await session.close();
  assert.equal(calls[2]?.command, 'detach');
});

test('extension session rejects unsupported modes and requires an approved page for actions', async () => {
  const session = new ChromeExtensionBrowserSession({
    async sendCommand() {
      return rawSnapshot;
    },
  });
  await assert.rejects(session.open('file:///tmp/page.html'), /only supports http/);
  await assert.rejects(session.open('https://example.com', { headless: true }), /does not support headless/);
  await assert.rejects(session.click('#submit'), /Use browser_open first/);
});

test('extension session adopts an origin only from an explicit user tab binding', async () => {
  const calls: Array<{ command: string; params: Record<string, unknown> }> = [];
  const session = new ChromeExtensionBrowserSession({
    getStatus() {
      return {
        activeTabBinding: 'user',
        userBoundOrigin: 'https://example.com',
      } as BrowserBridgeStatus;
    },
    async sendCommand(command, params) {
      calls.push({ command, params });
      return rawSnapshot;
    },
  });

  await session.snapshot();
  assert.deepEqual(calls, [{
    command: 'snapshot',
    params: { approvedOrigin: 'https://example.com' },
  }]);

  const unapproved = new ChromeExtensionBrowserSession({
    getStatus() {
      return {
        activeTabBinding: 'user',
        userBoundOrigin: null,
      } as BrowserBridgeStatus;
    },
    async sendCommand() { return rawSnapshot; },
  });
  await assert.rejects(unapproved.snapshot(), /Use browser_open first or click the extension action/);
});

test('extension session does not persist a live user-bound origin as agent approval', async () => {
  const calls: Array<{ command: string; params: Record<string, unknown> }> = [];
  let userBoundOrigin: string | null = null;
  const session = new ChromeExtensionBrowserSession({
    getStatus() {
      return {
        activeTabBinding: userBoundOrigin ? 'user' : null,
        userBoundOrigin,
      } as BrowserBridgeStatus;
    },
    async sendCommand(command, params) {
      calls.push({ command, params });
      const approvedOrigin = String(params.approvedOrigin);
      return { ...rawSnapshot, url: `${approvedOrigin}/page` };
    },
  });

  await session.open('https://agent.example/page');
  userBoundOrigin = 'https://user.example';
  await session.snapshot();
  userBoundOrigin = null;
  await session.snapshot();

  assert.deepEqual(calls.map((call) => call.params.approvedOrigin), [
    'https://agent.example',
    'https://user.example',
    'https://agent.example',
  ]);
});

test('extension session maps P1 interactions and normalizes extract and screenshot results', async () => {
  const calls: Array<{ command: string; params: Record<string, unknown> }> = [];
  const workdir = await mkdtemp(resolve(tmpdir(), 'pinpawo-browser-p1-'));
  const session = new ChromeExtensionBrowserSession({
    async sendCommand(command, params) {
      calls.push({ command, params });
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
  assert.deepEqual(calls.slice(1, 5).map((call) => call.command), [
    'click',
    'type',
    'scroll',
    'wait',
  ]);
  assert.deepEqual(calls[1]?.params.target, { selector: undefined, ref: 'snapshot-1:1' });
  assert.deepEqual(calls[4]?.params, {
    approvedOrigin: 'https://example.com',
    timeoutMs: 2_000,
    state: 'hidden',
    target: { selector: '#ready', ref: undefined },
  });
});

test('extension session rejects raw snapshots outside the approved origin', async () => {
  const session = new ChromeExtensionBrowserSession({
    async sendCommand() {
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
      return rawSnapshot;
    },
  });
  const text = '🙂'.repeat(4_001);

  await session.open('https://example.com/page');
  await session.type('#message', text);

  assert.equal(calls[1]?.params.text, text);
  assert.ok((calls[1]?.timeoutMs ?? 0) > 30_000);
});
