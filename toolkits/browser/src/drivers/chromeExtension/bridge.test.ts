import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { connect, type Socket } from 'node:net';
import test from 'node:test';
import { BROWSER_EXTENSION_PROTOCOL_VERSION } from './protocol';
import { BrowserBridgeError, BrowserExtensionBridge } from './bridge';
import { BrowserLifecycleController } from '../../lifecycle/controller';

type LinePeer = {
  socket: Socket;
  nextLine: () => Promise<Record<string, unknown>>;
  send: (message: unknown) => void;
};

test('browser bridge tracks navigation generations independently per browser context', () => {
  const bridge = new BrowserExtensionBridge();

  assert.equal(bridge.beginNavigation('context-a'), 1);
  assert.equal(bridge.beginNavigation('context-b'), 1);
  assert.equal(bridge.beginNavigation('context-a'), 2);
  assert.equal(bridge.beginNavigation(), 1);
});

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

async function connectLinePeer(socketPath: string): Promise<LinePeer> {
  const socket = connect(socketPath);
  socket.setEncoding('utf8');
  await new Promise<void>((resolvePromise, rejectPromise) => {
    socket.once('connect', resolvePromise);
    socket.once('error', rejectPromise);
  });

  let buffer = '';
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  socket.on('data', (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
      newline = buffer.indexOf('\n');
    }
  });

  return {
    socket,
    nextLine: async () => {
      const line = lines.shift() ?? await new Promise<string>((resolvePromise) => {
        waiters.push(resolvePromise);
      });
      return JSON.parse(line) as Record<string, unknown>;
    },
    send: (message) => socket.write(`${JSON.stringify(message)}\n`),
  };
}

test('local browser bridge authenticates, registers and resolves commands', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'pinpawo-browser-bridge-'));
  const socketPath = resolve(root, 'bridge.sock');
  const tokenPath = resolve(root, 'bridge.token');
  const warnings: string[] = [];
  const bridge = new BrowserExtensionBridge({
    socketPath,
    tokenPath,
    tokenFactory: () => 'test-token',
    logger: {
      info() {},
      warn(message) { warnings.push(String(message)); },
      error() {},
    },
  });
  await bridge.start();
  t.after(async () => bridge.stop());

  assert.equal((await readFile(tokenPath, 'utf8')).trim(), 'test-token');
  assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
  assert.equal((await stat(socketPath)).mode & 0o777, 0o600);

  const peer = await connectLinePeer(socketPath);
  t.after(() => peer.socket.destroy());
  peer.send({
    type: 'bridge.hello',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    token: 'test-token',
    hostPid: process.pid,
  });
  assert.deepEqual(await peer.nextLine(), {
    type: 'bridge.ready',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
  });

  peer.send({
    type: 'browser.register',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    extensionId: 'extension-1',
    capabilities: ['navigate', 'snapshot', 'detach'],
    activeTab: { tabId: 42, binding: 'user' },
    state: {
      revision: 2,
      debuggerAttached: true,
      activeTab: { tabId: 42, binding: 'user' },
      userBoundOrigin: 'https://example.com',
    },
  });
  await waitUntil(() => bridge.getStatus().extensionConnected);
  assert.equal(bridge.getStatus().extensionConnected, true);
  assert.equal(bridge.getStatus().activeTabId, 42);
  assert.equal(bridge.getStatus().debuggerAttached, true);
  assert.equal(bridge.getStatus().stateRevision, 2);
  assert.equal(bridge.getStatus().userBoundOrigin, 'https://example.com');

  peer.send({
    type: 'browser.register',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    extensionId: 'extension-1',
    capabilities: ['navigate', 'snapshot', 'detach'],
    activeTab: { tabId: 7, binding: 'user' },
    state: {
      revision: 1,
      debuggerAttached: false,
      activeTab: { tabId: 7, binding: 'user' },
    },
  });
  await waitUntil(() => warnings.some((message) => message.includes('stale browser state revision')));
  assert.equal(bridge.getStatus().activeTabId, 42);
  assert.equal(bridge.getStatus().debuggerAttached, true);
  assert.equal(bridge.getStatus().stateRevision, 2);

  warnings.length = 0;
  peer.send({
    type: 'browser.register',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    extensionId: 'extension-1',
    capabilities: ['navigate', 'snapshot', 'detach'],
    activeTab: { tabId: 9, binding: 'user' },
  });
  await waitUntil(() => warnings.some((message) => message.includes('revision legacy')));
  assert.equal(bridge.getStatus().activeTabId, 42);
  assert.equal(bridge.getStatus().debuggerAttached, true);
  assert.equal(bridge.getStatus().stateRevision, 2);

  const resultPromise = bridge.sendCommand('snapshot', { approvedOrigin: 'https://example.com' });
  const command = await peer.nextLine();
  assert.equal(command.type, 'browser.command');
  assert.equal(command.connectionId, 'connection-1');
  assert.equal(command.command, 'snapshot');
  assert.equal((command.params as Record<string, unknown>).approvedOrigin, 'https://example.com');

  peer.send({
    type: 'browser.result',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    requestId: command.requestId,
    ok: true,
    result: { title: 'Example' },
  });
  assert.deepEqual(await resultPromise, { title: 'Example' });

  const cancellationController = new AbortController();
  const cancelledPromise = bridge.sendCommand(
    'snapshot',
    { approvedOrigin: 'https://example.com' },
    undefined,
    cancellationController.signal,
  );
  const cancelledCommand = await peer.nextLine();
  cancellationController.abort();
  await assert.rejects(
    cancelledPromise,
    (error: unknown) => error instanceof BrowserBridgeError
      && error.code === 'browser_command_cancelled',
  );
  const cancellation = await peer.nextLine();
  assert.deepEqual(cancellation, {
    type: 'browser.cancel',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    requestId: cancelledCommand.requestId,
  });
  peer.send({
    type: 'browser.result',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    requestId: cancelledCommand.requestId,
    ok: true,
    result: { ignored: true },
  });

  const failedPromise = bridge.sendCommand('snapshot', {
    approvedOrigin: 'https://example.com',
  });
  const failedCommand = await peer.nextLine();
  peer.send({
    type: 'browser.result',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    requestId: failedCommand.requestId,
    ok: false,
    error: {
      code: 'origin_changed',
      message: 'Origin changed',
      retryable: false,
      details: {
        approvedOrigin: 'https://example.com',
        actualOrigin: 'https://login.example.com',
      },
    },
  });
  await assert.rejects(
    failedPromise,
    (error: unknown) => error instanceof BrowserBridgeError
      && error.code === 'origin_changed'
      && error.details?.actualOrigin === 'https://login.example.com',
  );
});

test('local browser bridge rejects wrong tokens and reports disconnected extension', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'pinpawo-browser-bridge-auth-'));
  const bridge = new BrowserExtensionBridge({
    socketPath: resolve(root, 'bridge.sock'),
    tokenPath: resolve(root, 'bridge.token'),
    tokenFactory: () => 'expected-token',
    logger: { info() {}, warn() {}, error() {} },
  });
  await bridge.start();
  t.after(async () => bridge.stop());

  await assert.rejects(
    bridge.sendCommand('snapshot', {}),
    (error: unknown) => error instanceof BrowserBridgeError
      && error.code === 'browser_extension_disconnected',
  );

  const peer = await connectLinePeer(bridge.getStatus().socketPath);
  peer.send({
    type: 'bridge.hello',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    token: 'wrong-token',
    hostPid: process.pid,
  });
  await new Promise<void>((resolvePromise) => peer.socket.once('close', () => resolvePromise()));
  assert.equal(bridge.getStatus().hostConnected, false);
});

test('local browser bridge cleans up token and state when socket startup fails', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'pinpawo-browser-bridge-start-failure-'));
  const tokenPath = resolve(root, 'bridge.token');
  const bridge = new BrowserExtensionBridge({
    socketPath: resolve(root, 'x'.repeat(160), 'bridge.sock'),
    tokenPath,
    tokenFactory: () => 'test-token',
    logger: { info() {}, warn() {}, error() {} },
  });

  await assert.rejects(bridge.start());
  assert.equal(bridge.getStatus().listening, false);
  await assert.rejects(readFile(tokenPath, 'utf8'), { code: 'ENOENT' });
});

test('local browser bridge retains the first active extension connection', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'pinpawo-browser-bridge-single-active-'));
  const warnings: string[] = [];
  const bridge = new BrowserExtensionBridge({
    socketPath: resolve(root, 'bridge.sock'),
    tokenPath: resolve(root, 'bridge.token'),
    tokenFactory: () => 'test-token',
    logger: {
      info() {},
      warn(message) { warnings.push(String(message)); },
      error() {},
    },
  });
  await bridge.start();
  t.after(async () => bridge.stop());

  const first = await connectLinePeer(bridge.getStatus().socketPath);
  t.after(() => first.socket.destroy());
  first.send({
    type: 'bridge.hello',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    token: 'test-token',
    hostPid: process.pid,
  });
  await first.nextLine();
  first.send({
    type: 'browser.register',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'first-extension',
    extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    capabilities: ['snapshot'],
    state: { revision: 1, debuggerAttached: false },
  });
  await waitUntil(() => bridge.getStatus().connectionId === 'first-extension');

  const second = await connectLinePeer(bridge.getStatus().socketPath);
  t.after(() => second.socket.destroy());
  const secondClosed = new Promise<void>((resolvePromise) => second.socket.once('close', resolvePromise));
  second.send({
    type: 'bridge.hello',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    token: 'test-token',
    hostPid: process.pid + 1,
  });
  await second.nextLine();
  second.send({
    type: 'browser.register',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'second-extension',
    extensionId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    capabilities: ['snapshot'],
    state: { revision: 1, debuggerAttached: false },
  });
  await secondClosed;

  assert.equal(bridge.getStatus().connectionId, 'first-extension');
  assert.equal(bridge.getStatus().extensionId, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.ok(warnings.some((message) => message.includes('additional native host')));

  const commandPromise = bridge.sendCommand('snapshot', { approvedOrigin: 'https://example.com' });
  const command = await first.nextLine();
  assert.equal(command.connectionId, 'first-extension');
  first.send({
    type: 'browser.result',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'first-extension',
    requestId: command.requestId,
    ok: true,
    result: { title: 'First extension retained' },
  });
  assert.deepEqual(await commandPromise, { title: 'First extension retained' });
});

test('local browser bridge promotes a reconnect from the active extension', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'pinpawo-browser-bridge-reconnect-'));
  const bridge = new BrowserExtensionBridge({
    socketPath: resolve(root, 'bridge.sock'),
    tokenPath: resolve(root, 'bridge.token'),
    tokenFactory: () => 'test-token',
    logger: { info() {}, warn() {}, error() {} },
  });
  await bridge.start();
  t.after(async () => bridge.stop());

  const first = await connectLinePeer(bridge.getStatus().socketPath);
  t.after(() => first.socket.destroy());
  first.send({
    type: 'bridge.hello',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    token: 'test-token',
    hostPid: process.pid,
  });
  await first.nextLine();
  first.send({
    type: 'browser.register',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'extension-worker-1',
    extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    capabilities: ['snapshot'],
    state: { revision: 1, debuggerAttached: false },
  });
  await waitUntil(() => bridge.getStatus().connectionId === 'extension-worker-1');

  const pending = bridge.sendCommand('snapshot', { approvedOrigin: 'https://example.com' });
  const pendingRejected = assert.rejects(
    pending,
    (error: unknown) => error instanceof BrowserBridgeError
      && error.code === 'browser_connection_replaced',
  );
  await first.nextLine();
  const firstClosed = new Promise<void>((resolvePromise) => first.socket.once('close', resolvePromise));

  const reconnect = await connectLinePeer(bridge.getStatus().socketPath);
  t.after(() => reconnect.socket.destroy());
  reconnect.send({
    type: 'bridge.hello',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    token: 'test-token',
    hostPid: process.pid + 1,
  });
  assert.deepEqual(await reconnect.nextLine(), {
    type: 'bridge.ready',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
  });
  reconnect.send({
    type: 'browser.register',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'extension-worker-2',
    extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    capabilities: ['snapshot'],
    state: { revision: 1, debuggerAttached: false },
  });

  await firstClosed;
  await pendingRejected;
  await waitUntil(() => bridge.getStatus().connectionId === 'extension-worker-2');

  const recovered = bridge.sendCommand('snapshot', { approvedOrigin: 'https://example.com' });
  const command = await reconnect.nextLine();
  assert.equal(command.connectionId, 'extension-worker-2');
  reconnect.send({
    type: 'browser.result',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'extension-worker-2',
    requestId: command.requestId,
    ok: true,
    result: { title: 'Reconnected extension' },
  });
  assert.deepEqual(await recovered, { title: 'Reconnected extension' });
});

test('local browser bridge forwards browser events to runtime subscribers', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'pinpawo-browser-bridge-events-'));
  const bridge = new BrowserExtensionBridge({
    socketPath: resolve(root, 'bridge.sock'),
    tokenPath: resolve(root, 'bridge.token'),
    tokenFactory: () => 'test-token',
    logger: { info() {}, warn() {}, error() {} },
  });
  await bridge.start();
  t.after(async () => bridge.stop());

  const received: Array<Record<string, unknown>> = [];
  const unsubscribe = bridge.onRuntimeEvent((event) => {
    received.push(event as unknown as Record<string, unknown>);
  });
  t.after(unsubscribe);

  const peer = await connectLinePeer(bridge.getStatus().socketPath);
  t.after(() => peer.socket.destroy());
  peer.send({
    type: 'bridge.hello',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    token: 'test-token',
    hostPid: process.pid,
  });
  await peer.nextLine();
  peer.send({
    type: 'browser.register',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    capabilities: ['navigate', 'snapshot'],
    activeTab: { tabId: 42, binding: 'user' },
    state: { revision: 1, debuggerAttached: true, activeTab: { tabId: 42, binding: 'user' } },
  });
  await waitUntil(() => bridge.getStatus().connectionId === 'connection-1');

  peer.send({
    type: 'browser.event',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    event: 'navigation.committed',
    tabId: 42,
    url: 'https://example.com/',
  });
  await waitUntil(() => received.length === 1);

  const nav = received[0];
  assert.equal(nav.type, 'navigation.committed');
  assert.equal(nav.url, 'https://example.com/');
  assert.equal(nav.tabId, 42);
  assert.equal(typeof nav.connectionGeneration, 'number');
  assert.equal(typeof nav.targetGeneration, 'number');
  assert.equal(typeof nav.timestamp, 'number');
});

test('local browser bridge stamps navigationGeneration on navigation-scoped events after beginNavigation', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'pinpawo-browser-bridge-navgen-'));
  const bridge = new BrowserExtensionBridge({
    socketPath: resolve(root, 'bridge.sock'),
    tokenPath: resolve(root, 'bridge.token'),
    tokenFactory: () => 'test-token',
    logger: { info() {}, warn() {}, error() {} },
  });
  await bridge.start();
  t.after(async () => bridge.stop());

  const received: Array<Record<string, unknown>> = [];
  const unsubscribe = bridge.onRuntimeEvent((event) => {
    received.push(event as unknown as Record<string, unknown>);
  });
  t.after(unsubscribe);

  const peer = await connectLinePeer(bridge.getStatus().socketPath);
  t.after(() => peer.socket.destroy());
  peer.send({
    type: 'bridge.hello',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    token: 'test-token',
    hostPid: process.pid,
  });
  await peer.nextLine();
  peer.send({
    type: 'browser.register',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    capabilities: ['navigate', 'snapshot'],
    activeTab: { tabId: 42, binding: 'user' },
    state: { revision: 1, debuggerAttached: true, activeTab: { tabId: 42, binding: 'user' } },
  });
  await waitUntil(() => bridge.getStatus().connectionId === 'connection-1');

  // A navigation starts: the explicit boundary stamps subsequent nav-scoped
  // events with a navigation generation.
  const g1 = bridge.beginNavigation();
  peer.send({
    type: 'browser.event',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    event: 'document.ready',
    tabId: 42,
    payload: { readyState: 'complete' },
  });
  await waitUntil(() => received.length === 1);
  assert.equal(received[0].type, 'document.ready');
  assert.equal(received[0].navigationGeneration, g1);

  // A second beginNavigation bumps the generation.
  const g2 = bridge.beginNavigation();
  assert.equal(g2, g1 + 1);
  peer.send({
    type: 'browser.event',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    event: 'navigation.committed',
    tabId: 42,
    url: 'https://example.com/route-a',
  });
  await waitUntil(() => received.length === 2);
  assert.equal(received[1].navigationGeneration, g2);
});

test('local browser bridge maps legacy tab.navigated onto navigation.committed and bumps target generation on close', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'pinpawo-browser-bridge-legacy-'));
  const bridge = new BrowserExtensionBridge({
    socketPath: resolve(root, 'bridge.sock'),
    tokenPath: resolve(root, 'bridge.token'),
    tokenFactory: () => 'test-token',
    logger: { info() {}, warn() {}, error() {} },
  });
  await bridge.start();
  t.after(async () => bridge.stop());

  const received: Array<Record<string, unknown>> = [];
  bridge.onRuntimeEvent((event) => {
    received.push(event as unknown as Record<string, unknown>);
  });

  const peer = await connectLinePeer(bridge.getStatus().socketPath);
  t.after(() => peer.socket.destroy());
  peer.send({
    type: 'bridge.hello',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    token: 'test-token',
    hostPid: process.pid,
  });
  await peer.nextLine();
  peer.send({
    type: 'browser.register',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    capabilities: ['navigate', 'snapshot'],
    activeTab: { tabId: 42, binding: 'user' },
    state: { revision: 1, debuggerAttached: true, activeTab: { tabId: 42, binding: 'user' } },
  });
  await waitUntil(() => bridge.getStatus().connectionId === 'connection-1');

  peer.send({
    type: 'browser.event',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    event: 'tab.navigated',
    tabId: 42,
    url: 'https://example.com/',
  });
  await waitUntil(() => received.length === 1);
  assert.equal(received[0].type, 'navigation.committed');
  assert.equal(received[0].url, 'https://example.com/');

  const before = bridge.getStatus().targetGeneration ?? 0;
  peer.send({
    type: 'browser.event',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    event: 'target.closed',
    tabId: 42,
  });
  await waitUntil(() => received.length === 2);
  assert.equal(received[1].type, 'target.closed');
  assert.equal(bridge.getStatus().targetGeneration ?? 0, before + 1);
});

// -- Generation-bump notification (review #5: the seam must have a producer) --
test('local browser bridge notifies generation subscribers on reconnect and target close', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'pinpawo-browser-bridge-gennotify-'));
  const bridge = new BrowserExtensionBridge({
    socketPath: resolve(root, 'bridge.sock'),
    tokenPath: resolve(root, 'bridge.token'),
    tokenFactory: () => 'test-token',
    logger: { info() {}, warn() {}, error() {} },
  });
  await bridge.start();
  t.after(async () => bridge.stop());

  const bumps: Array<{ connectionGeneration: number; targetGeneration: number }> = [];
  const unsubscribe = bridge.onGenerationChanged((change) => {
    bumps.push({ ...change });
  });
  t.after(unsubscribe);

  const first = await connectLinePeer(bridge.getStatus().socketPath);
  t.after(() => first.socket.destroy());
  first.send({
    type: 'bridge.hello',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    token: 'test-token',
    hostPid: process.pid,
  });
  await first.nextLine();
  first.send({
    type: 'browser.register',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    capabilities: ['navigate', 'snapshot'],
    activeTab: { tabId: 42, binding: 'user' },
    state: { revision: 1, debuggerAttached: true, activeTab: { tabId: 42, binding: 'user' } },
  });
  await waitUntil(() => bridge.getStatus().connectionId === 'connection-1');
  // The initial socket goes through `replaceActiveSocket`, so a connection
  // bump is already notified; capture the caller-visible generation baseline.
  const targetBeforeClose = bridge.getStatus().targetGeneration ?? 0;

  // Target close bumps targetGeneration.
  first.send({
    type: 'browser.event',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    event: 'target.closed',
    tabId: 42,
  });
  await waitUntil(() => (bridge.getStatus().targetGeneration ?? 0) === targetBeforeClose + 1);
  assert.ok(bumps.some((b) => b.targetGeneration === targetBeforeClose + 1));

  // A reconnect (new native host replaces the active socket) bumps
  // connectionGeneration and notifies subscribers.
  const connectionBeforeReconnect = bridge.getStatus().connectionGeneration ?? 0;
  const reconnect = await connectLinePeer(bridge.getStatus().socketPath);
  t.after(() => reconnect.socket.destroy());
  reconnect.send({
    type: 'bridge.hello',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    token: 'test-token',
    hostPid: process.pid + 1,
  });
  await reconnect.nextLine();
  reconnect.send({
    type: 'browser.register',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-2',
    extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    capabilities: ['navigate', 'snapshot'],
    activeTab: { tabId: 42, binding: 'user' },
    state: { revision: 1, debuggerAttached: true, activeTab: { tabId: 42, binding: 'user' } },
  });
  await waitUntil(() => bridge.getStatus().connectionId === 'connection-2');
  assert.ok(bumps.some((b) => b.connectionGeneration >= connectionBeforeReconnect + 1));
});

// -- End-to-end pairing: a bridge-produced event and a controller-produced
//    context must agree on the navigation generation (review: one owner). --
test('bridge events drive a controller that binds the bridge navigation generation', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'pinpawo-browser-bridge-controller-'));
  const bridge = new BrowserExtensionBridge({
    socketPath: resolve(root, 'bridge.sock'),
    tokenPath: resolve(root, 'bridge.token'),
    tokenFactory: () => 'test-token',
    logger: { info() {}, warn() {}, error() {} },
  });
  await bridge.start();
  t.after(async () => bridge.stop());

  const controller = new BrowserLifecycleController();
  // The driver subscribes the controller to the bridge's event stream.
  bridge.onRuntimeEvent((event) => {
    controller.handleEvent(event);
  });

  const peer = await connectLinePeer(bridge.getStatus().socketPath);
  t.after(() => peer.socket.destroy());
  peer.send({
    type: 'bridge.hello',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    token: 'test-token',
    hostPid: process.pid,
  });
  await peer.nextLine();
  peer.send({
    type: 'browser.register',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    capabilities: ['navigate', 'snapshot'],
    activeTab: { tabId: 42, binding: 'user' },
    state: { revision: 1, debuggerAttached: true, activeTab: { tabId: 42, binding: 'user' } },
  });
  await waitUntil(() => bridge.getStatus().connectionId === 'connection-1');

  // Navigate 1: the bridge is the single owner of the navigation generation.
  // The caller binds the bridge's live connection/target generation (which may
  // differ from 1 — the native host connection increments it on registration).
  const { connectionGeneration, targetGeneration } = bridge.getStatus();
  const g1 = bridge.beginNavigation();
  controller.beginNavigation(
    'https://example.com/a',
    'https://example.com',
    connectionGeneration as number,
    targetGeneration as number,
    g1,
  );

  peer.send({
    type: 'browser.event',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    event: 'navigation.committed',
    tabId: 42,
    url: 'https://example.com/a',
  });
  await waitUntil(() => controller.getSnapshot().navigation?.phase === 'committed');
  assert.equal(controller.getSnapshot().navigation?.committedUrl, 'https://example.com/a');

  // SPA route change (no `navigate` command): driver calls beginNavigation to
  // demarcate the boundary, then rebinds the controller.
  const g2 = bridge.beginNavigation();
  assert.notEqual(g2, g1);
  controller.beginNavigation(
    'https://example.com/b',
    'https://example.com',
    connectionGeneration as number,
    targetGeneration as number,
    g2,
  );
  peer.send({
    type: 'browser.event',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    event: 'navigation.committed',
    tabId: 42,
    url: 'https://example.com/b',
  });
  await waitUntil(() => controller.getSnapshot().navigation?.phase === 'committed');
  assert.equal(controller.getSnapshot().navigation?.committedUrl, 'https://example.com/b');

  // The controller context and the bridge generation agree: without the single
  // owner, an SPA route change (which produces no `navigate` command) would
  // desync the two counters and every live event would be mis-rejected as stale.
  assert.equal(controller.getSnapshot().context?.navigationGeneration, g2);
  assert.equal(bridge.getStatus().navigationGeneration, g2);

  // A navigation-scoped event dispatched after the SPA boundary is stamped with
  // g2 by the bridge and accepted against the controller's g2 binding.
  peer.send({
    type: 'browser.event',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    event: 'document.ready',
    tabId: 42,
    payload: { readyState: 'complete' },
  });
  await waitUntil(() => controller.getSnapshot().navigation?.readyState === 'complete');
});
