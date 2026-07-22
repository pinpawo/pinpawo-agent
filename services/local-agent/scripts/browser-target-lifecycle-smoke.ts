import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { BrowserSession } from '../src/toolkits/browser/session';

type Snapshot = { title: string; url: string };

const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  if (request.url === '/child') {
    response.end(`<!doctype html>
      <title>Popup child</title>
      <button id="close-popup" onclick="window.close()">Close popup</button>`);
    return;
  }
  response.end(`<!doctype html>
    <title>Popup parent</title>
    <button id="open-popup" onclick="window.open('/child', '_blank')">Open popup</button>`);
});

await new Promise<void>((resolvePromise, rejectPromise) => {
  server.once('error', rejectPromise);
  server.listen(0, '127.0.0.1', resolvePromise);
});

const address = server.address();
if (!address || typeof address === 'string') {
  throw new Error('Smoke server did not expose a TCP port');
}

const profileDir = await mkdtemp(resolve(tmpdir(), 'pinpawo-browser-popup-smoke-'));
const browser = new BrowserSession();

try {
  const parentUrl = `http://127.0.0.1:${address.port}/parent`;
  const opened = JSON.parse(await browser.openWithProfile(parentUrl, profileDir, {
    headless: true,
  })) as Snapshot;
  assert.equal(new URL(opened.url).pathname, '/parent');

  const child = JSON.parse(await browser.click('#open-popup')) as Snapshot;
  assert.equal(new URL(child.url).pathname, '/child');

  const returned = JSON.parse(await browser.click('#close-popup')) as Snapshot;
  assert.equal(new URL(returned.url).pathname, '/parent');
  console.log('[browser-smoke] popup follow and parent fallback passed');
} finally {
  await browser.close();
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  await rm(profileDir, { recursive: true, force: true });
}
