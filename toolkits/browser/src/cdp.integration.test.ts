import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CdpConnection } from './connection';
import { createCdpRuntime, type CdpRuntimeCallContext } from './runtime';

const enabled = process.env.PINPAWO_TEST_CDP === '1';

test('real CDP: borrowed ownership, refs, popup origins, extraction, screenshot, cancellation and clients', { skip: !enabled, timeout: 60_000 }, async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), 'pinpawo-cdp-test-'));
  const profile = join(workdir, 'profile');
  let otherOrigin = '';
  let unapprovedActions = 0;
  const server = createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: otherOrigin + '/secret' }); response.end(); return; }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url === '/popup') { response.end('<title>Popup</title><h1>Same-origin popup</h1>'); return; }
    if (request.url === '/b') { response.end('<title>Host B</title><h1>Private B page</h1>'); return; }
    if (request.url === '/delayed-redirect') { response.end('<title>Pending</title><script>setTimeout(() => location.href=' + JSON.stringify(otherOrigin + '/secret') + ', 500)</script>'); return; }
    response.end('<title>CDP main</title><h1>Main page</h1><button id="click" onclick="this.textContent=\'Clicked\'">Click me</button><input id="text"><button id="popup" onclick="window.open(\'/popup\')">Popup</button><button id="cross" onclick="window.open(\'' + otherOrigin + '/secret\')">Cross origin</button><div>' + 'Long article '.repeat(5000) + '</div>');
  });
  const other = createServer((request, response) => {
    if (request.url === '/side-effect') unapprovedActions += 1;
    response.end('<h1>Private other-origin content</h1><button id="unapproved" onclick="fetch(\'/side-effect\')">Unsafe action</button>');
  });
  await Promise.all([new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)), new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve))]);
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  otherOrigin = 'http://127.0.0.1:' + (other.address() as { port: number }).port;
  const harness = new CdpConnection({ headless: true, userDataDir: profile });
  let runtime: ReturnType<typeof createCdpRuntime> | undefined;
  t.after(async () => {
    await runtime?.close();
    await harness.close();
    await Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), new Promise<void>((resolve) => other.close(() => resolve()))]);
    await rm(workdir, { recursive: true, force: true });
  });
  const browser = await harness.getBrowser();
  const initialPages = browser.contexts()[0]!.pages();
  const userPage = await browser.contexts()[0]!.newPage();
  await userPage.goto(origin + '/b');
  const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
  runtime = createCdpRuntime({ endpoint: 'http://127.0.0.1:' + port });
  const a: CdpRuntimeCallContext = { clientId: 'host-a', toolkitName: 'browser', execution: { threadId: 'same-thread', workdir } };
  const b: CdpRuntimeCallContext = { ...a, clientId: 'host-b' };
  const call = async (method: string, args: unknown[] = [], context = a) => runtime!.call(method, args, context);
  const parentSnapshot = async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      try { return await call('snapshot') as string; } catch (error) {
        if (attempt === 19) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    }
    throw new Error('Parent page was not restored.');
  };
  const opened = JSON.parse(await call('open', [origin]) as string);
  assert.equal(opened.title, 'CDP main');
  assert.equal(opened.hasMore, true);
  const clickRef = opened.interactive.find((item: { text: string }) => item.text === 'Click me').ref;
  assert.match(await call('click', [{ ref: clickRef }]) as string, /Clicked/);
  await assert.rejects(call('click', [{ ref: clickRef }]), { code: 'stale_element_reference' });
  await call('type', [{ selector: '#text' }, 'typed']);
  const extract = JSON.parse(await call('extract', [{ offset: 100, limit: 17 }]) as string);
  assert.equal(extract.text.length, 17);
  assert.equal(extract.nextOffset, 117);
  const screenshot = JSON.parse(await call('screenshot') as string);
  assert.ok((await stat(screenshot.path)).size > 0);
  await call('open', [origin + '/b'], b);
  assert.match(await call('snapshot') as string, /CDP main/);
  assert.match(await call('snapshot', [], b) as string, /Host B/);
  await call('click', [{ selector: '#popup' }]);
  assert.match(await call('snapshot') as string, /Same-origin popup/);
  await browser.contexts()[0]!.pages().find((page) => page.url() === origin + '/popup')!.close();
  assert.match(await parentSnapshot(), /CDP main/);
  await assert.rejects(call('click', [{ selector: '#cross' }]), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'origin_changed');
    assert.equal((error as { details: { interactionDispatched: boolean } }).details.interactionDispatched, true);
    return true;
  });
  await assert.rejects(call('extract'), { code: 'origin_changed' });
  await browser.contexts()[0]!.pages().find((page) => page.url() === otherOrigin + '/secret')!.close();
  assert.match(await parentSnapshot(), /CDP main/);
  await assert.rejects(call('open', [origin + '/redirect']), { code: 'origin_changed' });
  await call('open', [origin + '/delayed-redirect']);
  await assert.rejects(call('click', [{ selector: '#unapproved' }]), { code: 'origin_changed' });
  assert.equal(unapprovedActions, 0);
  await call('open', [origin]);
  await runtime.releaseClient(a.clientId);
  assert.match(await call('snapshot', [], b) as string, /Host B/);
  assert.equal(userPage.isClosed(), false);
  await assert.rejects(stat(screenshot.path), { code: 'ENOENT' });
  const cancelled = new AbortController();
  const waiting = call('wait', [{ selector: '#never' }, 30_000], { ...b, signal: cancelled.signal });
  setTimeout(() => cancelled.abort(), 50);
  await assert.rejects(waiting, { code: 'browser_command_cancelled' });
  await assert.rejects(call('snapshot', [], b), { code: 'browser_not_open' });
  const c = { ...a, clientId: 'host-c' };
  const opening = call('open', [origin], c);
  await runtime.releaseClient(c.clientId);
  await assert.rejects(opening);
  await runtime.close();
  assert.equal(browser.isConnected(), true);
  assert.equal(userPage.isClosed(), false);
  assert.ok(initialPages.every((page) => !page.isClosed()));
});

test('real CDP: managed process closes and named contexts isolate storage', { skip: !enabled, timeout: 45_000 }, async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), 'pinpawo-cdp-owned-'));
  const runtime = createCdpRuntime({ headless: true });
  const server = createServer((_request, response) => response.end('<h1>Managed CDP</h1><p id="storage"></p><script>if(location.search) localStorage.setItem("token","named-session"); document.getElementById("storage").textContent=localStorage.getItem("token")||"no-token";</script>'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  t.after(async () => { await runtime.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(workdir, { recursive: true, force: true }); });
  const context = { clientId: 'owned', toolkitName: 'browser', execution: { threadId: 'thread', workdir } };
  assert.match(await runtime.call('open', [url + '?save', { headless: true, session: 'isolated' }], context) as string, /named-session/);
  assert.deepEqual(await runtime.call('listSessions', [], context), ['isolated']);
  assert.match(await runtime.call('open', [url], context) as string, /no-token/);
  assert.match(await runtime.call('open', [url, { session: 'isolated' }], context) as string, /named-session/);
  assert.equal(runtime.diagnose().ownership, 'managed');
  assert.equal(runtime.diagnose().connected, true);
  await runtime.close();
  assert.equal(runtime.diagnose().connected, false);
  assert.equal(runtime.diagnose().closed, true);
});
