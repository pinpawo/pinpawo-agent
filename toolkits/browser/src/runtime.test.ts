import assert from 'node:assert/strict';
import test from 'node:test';
import { createCdpRuntime } from './runtime';
import { validateCdpConfig } from './connection';
import type { CdpRuntimeConfig } from './options';
import { CdpBrowserSession } from './session';

test('CDP configuration rejects remote endpoints and conflicting ownership', () => {
  assert.throws(() => validateCdpConfig({ endpoint: 'http://example.com:9222' }), /local/);
  assert.throws(() => validateCdpConfig({ endpoint: 'http://127.0.0.1:9222', headless: true }), /borrowed/);
  assert.throws(() => validateCdpConfig({ userDataDir: '../profile' }), /absolute/);
  validateCdpConfig({ endpoint: 'ws://127.0.0.1:9222/devtools/browser/test' });
});

test('JSON CDP configuration validates scalar and environment types before starting resources', () => {
  for (const config of [
    { headless: 'false' }, { endpoint: 9222 }, { endpoint: '' },
    { executablePath: false }, { userDataDir: [] }, { timeoutMs: '1000' },
    { env: [] }, { env: { PATH: 1 } }, { env: { PATH: null } },
    { env: { 'INVALID=NAME': 'value' } },
  ]) {
    assert.throws(() => createCdpRuntime(config as unknown as CdpRuntimeConfig));
  }
  validateCdpConfig({ headless: false, env: {}, timeoutMs: 1000 });
  validateCdpConfig({ env: { PATH: '', LANG: 'C' } });
});

test('released CDP clients cannot create resources and calls require explicit ownership', async () => {
  const runtime = createCdpRuntime({ endpoint: 'http://127.0.0.1:1' });
  const context = { clientId: 'host-a', toolkitName: 'browser', execution: { threadId: 'thread', workdir: '/tmp' } };
  await runtime.releaseClient(context.clientId);
  await assert.rejects(runtime.call('open', ['https://example.com'], context), /released/);
  await assert.rejects(runtime.call('executeAnything', [], context), /Unknown/);
  await runtime.close();
});

test('pre-aborted CDP requests do not connect and a missing session does not adopt a browser page', async () => {
  const runtime = createCdpRuntime({ endpoint: 'http://127.0.0.1:1' });
  const context = { clientId: 'host', toolkitName: 'browser', execution: { threadId: 'thread', workdir: '/tmp' } };
  await assert.rejects(runtime.call('open', ['https://example.com'], { ...context, signal: AbortSignal.abort() }), { code: 'browser_command_cancelled' });
  await assert.rejects(runtime.call('snapshot', [], context), { code: 'browser_not_open' });
  assert.equal(runtime.diagnose().connected, false);
  assert.equal(runtime.diagnose().sessions, 0);
  await runtime.close();
});

test('client release waits for sessions whose explicit close is still pending', async (t) => {
  const runtime = createCdpRuntime({ endpoint: 'http://127.0.0.1:1' });
  const context = { clientId: 'closing', toolkitName: 'browser', execution: { threadId: 'thread', workdir: process.cwd() } };
  let finishClose!: () => void;
  const gate = new Promise<void>((resolve) => { finishClose = resolve; });
  const originalClose = CdpBrowserSession.prototype.close;
  t.mock.method(CdpBrowserSession.prototype, 'open', async () => 'opened');
  t.mock.method(CdpBrowserSession.prototype, 'close', async function (this: CdpBrowserSession) {
    await gate;
    return originalClose.call(this);
  });
  try {
    await runtime.call('open', ['https://example.com'], context);
    const closing = runtime.call('close', [], context);
    let released = false;
    const release = runtime.releaseClient(context.clientId).then(() => { released = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(released, false);
    assert.equal(runtime.diagnose().sessions, 1);
    finishClose();
    await Promise.all([closing, release]);
    assert.equal(runtime.diagnose().sessions, 0);
  } finally {
    finishClose();
    await runtime.close();
  }
});
