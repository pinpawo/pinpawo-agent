import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { calculateReconnectDelay, NativeHostRelay } from './relay';
import { encodeNativeMessage, NativeMessageDecoder } from './framing';
import { BROWSER_EXTENSION_PROTOCOL_VERSION } from '../../../drivers/chromeExtension/protocol';
import { BrowserExtensionBridge } from '../../../drivers/chromeExtension/bridge';

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

test('native host reconnect backoff grows exponentially within a bounded jitter range', () => {
  assert.equal(calculateReconnectDelay(0, 1_000, 30_000, () => 0), 500);
  assert.equal(calculateReconnectDelay(1, 1_000, 30_000, () => 0.5), 1_500);
  assert.equal(calculateReconnectDelay(10, 1_000, 30_000, () => 1), 30_000);
});

test('native host relays framed Chrome messages to the authenticated local bridge', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'pinpawo-native-host-'));
  const socketPath = resolve(root, 'bridge.sock');
  const tokenPath = resolve(root, 'bridge.token');
  const logger = { info() {}, warn() {}, error() {} };
  const bridge = new BrowserExtensionBridge({ socketPath, tokenPath, logger });
  await bridge.start();
  t.after(async () => bridge.stop());

  const input = new PassThrough();
  const output = new PassThrough();
  const outputDecoder = new NativeMessageDecoder();
  const outputMessages: unknown[] = [];
  output.on('data', (chunk: Buffer) => outputMessages.push(...outputDecoder.push(chunk)));
  const relay = new NativeHostRelay({
    input,
    output,
    socketPath,
    tokenPath,
    reconnectDelayMs: 5,
    logger,
  });
  relay.start();
  t.after(() => relay.stop());

  input.write(encodeNativeMessage({
    type: 'browser.register',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'extension-worker-1',
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    capabilities: ['navigate', 'snapshot', 'detach'],
    activeTab: { tabId: 7, binding: 'user' },
  }));
  await waitUntil(() => bridge.getStatus().extensionConnected);

  const resultPromise = bridge.sendCommand('snapshot', {
    approvedOrigin: 'https://example.com',
  });
  await waitUntil(() => outputMessages.length > 0);
  const command = outputMessages.shift() as Record<string, unknown>;
  assert.equal(command.type, 'browser.command');
  assert.equal(command.command, 'snapshot');

  input.write(encodeNativeMessage({
    type: 'browser.result',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'extension-worker-1',
    requestId: command.requestId,
    ok: true,
    result: { title: 'Relayed' },
  }));
  assert.deepEqual(await resultPromise, { title: 'Relayed' });
});

test('native host replays extension registration when the local bridge restarts', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'pinpawo-native-host-restart-'));
  const socketPath = resolve(root, 'bridge.sock');
  const tokenPath = resolve(root, 'bridge.token');
  const logger = { info() {}, warn() {}, error() {} };
  const firstBridge = new BrowserExtensionBridge({ socketPath, tokenPath, logger });
  await firstBridge.start();

  const input = new PassThrough();
  const relay = new NativeHostRelay({
    input,
    output: new PassThrough(),
    socketPath,
    tokenPath,
    reconnectDelayMs: 5,
    logger,
  });
  relay.start();
  t.after(() => relay.stop());

  input.write(encodeNativeMessage({
    type: 'browser.register',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'extension-worker-restart',
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    capabilities: ['navigate', 'snapshot', 'detach'],
    activeTab: { tabId: 8, binding: 'agent' },
    state: {
      revision: 4,
      debuggerAttached: true,
      activeTab: { tabId: 8, binding: 'agent' },
    },
  }));
  await waitUntil(() => firstBridge.getStatus().extensionConnected);
  await firstBridge.stop();

  const secondBridge = new BrowserExtensionBridge({ socketPath, tokenPath, logger });
  await secondBridge.start();
  t.after(async () => secondBridge.stop());
  await waitUntil(() => secondBridge.getStatus().extensionConnected);

  assert.equal(secondBridge.getStatus().connectionId, 'extension-worker-restart');
  assert.equal(secondBridge.getStatus().activeTabId, 8);
  assert.equal(secondBridge.getStatus().debuggerAttached, true);
  assert.equal(secondBridge.getStatus().stateRevision, 4);
});

test('native host drops stale lifecycle events while retaining the latest registration', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'pinpawo-native-host-stale-events-'));
  const socketPath = resolve(root, 'bridge.sock');
  const tokenPath = resolve(root, 'bridge.token');
  const logger = { info() {}, warn() {}, error() {} };
  const input = new PassThrough();
  const relay = new NativeHostRelay({
    input,
    output: new PassThrough(),
    socketPath,
    tokenPath,
    reconnectDelayMs: 5,
    logger,
  });
  relay.start();
  t.after(() => relay.stop());

  input.write(encodeNativeMessage({
    type: 'browser.event',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'extension-worker-stale-events',
    event: 'target.closed',
    tabId: 7,
  }));
  input.write(encodeNativeMessage({
    type: 'browser.register',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'extension-worker-stale-events',
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    capabilities: ['navigate', 'snapshot', 'detach'],
    activeTab: { tabId: 8, binding: 'agent' },
    state: {
      revision: 2,
      debuggerAttached: true,
      activeTab: { tabId: 8, binding: 'agent' },
    },
  }));

  const bridge = new BrowserExtensionBridge({ socketPath, tokenPath, logger });
  await bridge.start();
  t.after(async () => bridge.stop());
  await waitUntil(() => bridge.getStatus().extensionConnected);

  assert.equal(bridge.getStatus().activeTabId, 8);
  assert.equal(bridge.getStatus().debuggerAttached, true);
  assert.equal(bridge.getStatus().stateRevision, 2);
  assert.equal(bridge.getStatus().targetAlive, true);
});
