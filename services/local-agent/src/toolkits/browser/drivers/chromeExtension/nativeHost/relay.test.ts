import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { NativeHostRelay } from './relay';
import { encodeNativeMessage, NativeMessageDecoder } from './framing';
import { BROWSER_EXTENSION_PROTOCOL_VERSION } from '../protocol';
import { LocalAgentBrowserBridge } from '../bridge';

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

test('native host relays framed Chrome messages to the authenticated local bridge', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'pinpawo-native-host-'));
  const socketPath = resolve(root, 'bridge.sock');
  const tokenPath = resolve(root, 'bridge.token');
  const logger = { info() {}, warn() {}, error() {} };
  const bridge = new LocalAgentBrowserBridge({ socketPath, tokenPath, logger });
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
    activeTab: { tabId: 7, ownership: 'user' },
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
