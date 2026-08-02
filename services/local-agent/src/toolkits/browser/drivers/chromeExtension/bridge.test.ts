import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { connect, type Socket } from 'node:net';
import test from 'node:test';
import { BROWSER_EXTENSION_PROTOCOL_VERSION } from './protocol';
import { BrowserBridgeError, LocalAgentBrowserBridge } from './bridge';

type LinePeer = {
  socket: Socket;
  nextLine: () => Promise<Record<string, unknown>>;
  send: (message: unknown) => void;
};

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
  const bridge = new LocalAgentBrowserBridge({
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
    activeTab: { tabId: 42, ownership: 'user' },
    state: {
      revision: 2,
      debuggerAttached: true,
      activeTab: { tabId: 42, ownership: 'user' },
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
    activeTab: { tabId: 7, ownership: 'user' },
    state: {
      revision: 1,
      debuggerAttached: false,
      activeTab: { tabId: 7, ownership: 'user' },
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
    activeTab: { tabId: 9, ownership: 'user' },
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
  const bridge = new LocalAgentBrowserBridge({
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

test('local browser bridge retains the first active extension connection', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'pinpawo-browser-bridge-single-active-'));
  const warnings: string[] = [];
  const bridge = new LocalAgentBrowserBridge({
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
