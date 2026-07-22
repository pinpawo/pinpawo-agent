import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ChromeExtensionBrowserSession } from '../src/toolkits/browser/drivers/chromeExtension/session';
import { browserRuntime } from '../src/toolkits/browser/runtime';

type Snapshot = { title: string; url: string };

const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  if (request.url === '/child') {
    response.end(`<!doctype html>
      <title>Extension popup child</title>
      <button id="close-popup" onclick="window.close()">Close popup</button>`);
    return;
  }
  response.end(`<!doctype html>
    <title>Extension popup parent</title>
    <a id="open-popup" href="/child" target="_blank" rel="opener"
      onclick="document.querySelector('#click-marker').textContent = 'clicked'">Open popup</a>
    <span id="click-marker">not clicked</span>
    <div id="delayed" hidden>Ready</div>
    <script>setTimeout(() => { document.querySelector('#delayed').hidden = false; }, 250)</script>`);
});

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForExtension(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (browserRuntime.getExtensionStatus().extensionConnected) return;
    await delay(100);
  }
  throw new Error(
    'PinPawo Chrome extension did not connect. Reload the unpacked extension and retry.',
  );
}

await new Promise<void>((resolvePromise, rejectPromise) => {
  server.once('error', rejectPromise);
  server.listen(0, '127.0.0.1', resolvePromise);
});

const address = server.address();
if (!address || typeof address === 'string') {
  throw new Error('Smoke server did not expose a TCP port');
}

const browser = new ChromeExtensionBrowserSession();
let extensionConnected = false;

try {
  await browserRuntime.start();
  await waitForExtension();
  extensionConnected = true;
  console.log('[browser-extension-smoke] extension connected');

  const parentUrl = `http://127.0.0.1:${address.port}/parent`;
  const opened = JSON.parse(await browser.open(parentUrl)) as Snapshot;
  assert.equal(new URL(opened.url).pathname, '/parent');
  console.log('[browser-extension-smoke] parent opened');
  await browser.wait('#delayed', 2_000, 'visible');
  console.log('[browser-extension-smoke] visible wait passed');

  const child = JSON.parse(await browser.click('#open-popup')) as Snapshot;
  if (new URL(child.url).pathname !== '/child') {
    console.log(`[browser-extension-smoke] parent result: ${JSON.stringify(child).slice(0, 2_000)}`);
  }
  assert.equal(new URL(child.url).pathname, '/child');
  console.log('[browser-extension-smoke] popup followed');

  const returned = JSON.parse(await browser.click('#close-popup')) as Snapshot;
  assert.equal(new URL(returned.url).pathname, '/parent');
  console.log('[browser-extension-smoke] parent restored');
  await browser.wait('#close-popup', 2_000, 'hidden');
  console.log('[browser-extension-smoke] popup follow, parent fallback and waits passed');
} finally {
  if (extensionConnected) await browser.close().catch(() => {});
  await browserRuntime.stop();
  server.closeAllConnections();
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
}
