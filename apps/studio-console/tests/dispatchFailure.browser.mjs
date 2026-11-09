import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const app = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(app, '../..');
const hostRoot = await mkdtemp(resolve(tmpdir(), 'dispatch-failure-console-'));
const children = [];
let browser;
const start = (args, cwd, env = {}) => {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env,
    LANGCHAIN_TRACING_V2: 'false', LANGSMITH_TRACING: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stderr.on('data', data => process.stderr.write(data));
  return child;
};
const readyLine = (child, accepts) => new Promise((resolve, reject) => {
  let buffer = '';
  const timer = setTimeout(() => reject(new Error('Startup timed out')), 20000);
  child.on('exit', code => { clearTimeout(timer); reject(new Error(`Exited ${code}`)); });
  child.stdout.on('data', data => {
    buffer += data;
    for (const line of buffer.split('\n').slice(0, -1)) {
      const result = accepts(line);
      if (result) { clearTimeout(timer); resolve(result); return; }
    }
  });
});
try {
  const host = start(['--import', 'tsx/esm', resolve(app, 'tests/support/channelHost.ts')], root,
    { CHANNEL_HOST_TEST_ROOT: hostRoot, TSX_TSCONFIG_PATH: resolve(app, 'tsconfig.browser.json') });
  const ready = await readyLine(host, line => line.startsWith('{"ready"') && JSON.parse(line));
  const post = async (path, body) => {
    const response = await fetch(ready.url + path, { method: 'POST', headers: {
      Authorization: `Bearer ${ready.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok(response.ok, `${path} ${response.status}`); return response.json();
  };
  const { channel: created } = await post('/channels', { title: 'Transport failure test', pets: ['alpha'] });
  await post('/channels', { title: 'Unrelated channel', pets: ['alpha'] });
  // This mode verifies the real event path even on machines without a browser.
  if (process.env.CHANNEL_API_ONLY) {
    const abort = new AbortController();
    const response = await fetch(ready.url + '/events', { headers: { Authorization: `Bearer ${ready.token}` }, signal: abort.signal });
    assert.ok(response.ok);
    const reader = response.body.getReader();
    const sent = await post('/channels/messages', { channelId: created.channelId, body: 'fail-transport', mentions: [{ participantId: 'pet:alpha' }] });
    assert.equal(sent.deliveries[0].state, 'accepted');
    let buffer = '', failed;
    const timer = setTimeout(() => abort.abort(), 10000);
    try {
      while (!failed) {
        const { value, done } = await reader.read();
        assert.equal(done, false, 'SSE must deliver the terminal execution observation');
        buffer += new TextDecoder().decode(value);
        for (let boundary; (boundary = buffer.indexOf('\n\n')) >= 0;) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const line = frame.split('\n').find(line => line.startsWith('data: '));
          if (!line) continue;
          const event = JSON.parse(line.slice(6));
          if (event.type === 'dispatch.failed' && event.payload.invocationId === sent.deliveries[0].invocationId) failed = event;
        }
      }
      assert.equal(failed.source, 'resident-pet');
      assert.equal(failed.payload.error, 'terminated');
      assert.equal(failed.payload.petId, 'alpha');
      assert.equal(failed.payload.sessionId, sent.deliveries[0].sessionId);
      assert.deepEqual(failed.payload.scope, { namespace: 'channel', id: created.channelId });
      assert.match(failed.payload.requestId, /^host-/);
      assert.deepEqual(failed.payload.diagnostics, { chain: [{ name: 'TypeError' }, { name: 'SocketError', code: 'UND_ERR_SOCKET', status: 502 }] });
      assert.doesNotMatch(JSON.stringify(failed.payload), /private|authorization|https/);
      console.log('PASS: real Host → Studio HTTP SSE execution failure with exact scope and bounded diagnostics.');
    } finally { clearTimeout(timer); abort.abort(); }
  } else {
    const vite = start([resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5199', '--strictPort'], app);
    await readyLine(vite, line => line.includes('http://127.0.0.1:5199'));
    browser = await chromium.launch({ headless: true, ...(process.env.CHANNEL_BROWSER_EXECUTABLE
      ? { executablePath: process.env.CHANNEL_BROWSER_EXECUTABLE } : {}) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:5199');
    await page.getByLabel('Studio HTTP URL').fill(ready.url);
    await page.getByLabel('Studio bearer token').fill(ready.token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.locator('.connection-state.connected').waitFor();
    await page.getByRole('button', { name: 'Transport failure test', exact: true }).click();
    const sent = await post('/channels/messages', { channelId: created.channelId, body: 'fail-transport', mentions: [{ participantId: 'pet:alpha' }] });
    assert.equal(sent.deliveries[0].state, 'accepted', 'HTTP response is admission, not execution');
    const alert = page.getByRole('alert').filter({ hasText: 'Alpha execution failed' });
    await alert.waitFor();
    const text = await alert.innerText();
    for (const item of ['terminated', 'UND_ERR_SOCKET', 'HTTP 502', sent.deliveries[0].invocationId, sent.deliveries[0].sessionId, 'Request: host-']) assert.ok(text.includes(item), item);
    assert.doesNotMatch(text, /private|authorization|https/);
    assert.equal(await alert.count(), 1);
    assert.equal(await alert.getByRole('button').count(), 0, 'observing a failure offers no automatic recovery');
    await page.getByRole('button', { name: 'Unrelated channel', exact: true }).click();
    assert.equal(await alert.count(), 0, 'error belongs only to its Channel');
    await page.getByRole('button', { name: 'Transport failure test', exact: true }).click();
    await alert.waitFor();
    assert.equal(await alert.count(), 1, 'navigation does not duplicate the observed error');
    assert.deepEqual(errors, []);
    const screenshots = process.env.CHANNEL_SCREENSHOTS ?? '/tmp/dispatch-failure-console-screenshots';
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: resolve(screenshots, 'dispatch-failure.png'), fullPage: true });
    console.log('PASS: real Host → Studio SSE → Channel error, bounded diagnostics, exact attribution, navigation isolation, no recovery.');
  }
} finally {
  await browser?.close();
  for (const child of children) child.kill('SIGTERM');
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  })));
  await rm(hostRoot, { recursive: true, force: true });
}
