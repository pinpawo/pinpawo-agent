import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Two transport fixtures: a protected Host and a cross-origin signed object.
// The browser runs the real Console and downloads the actual response bytes.
const app = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(app, '../..');
const port = process.env.ARTIFACT_BROWSER_PORT ?? '5317';
const origin = `http://127.0.0.1:${port}`;
const token = 'artifact-browser-fixture';
const localBytes = Buffer.from([0, 1, 2, 127, 128, 255]);
const cloudBytes = Buffer.from('Cloud report · 中文\n');
const date = '2026-11-03T00:00:00Z';
const localRef = { uri: 'artifact://workspace/session/local-id/local.bin', title: 'Local report' };
const cloudRef = { uri: 'artifact://workspace/session/cloud-id/cloud.txt', title: 'Cloud report' };
const references = [localRef, cloudRef];
const channel = { channelId: 'files', title: 'Files', createdBy: { kind: 'human', id: 'owner' }, createdAt: date, updatedAt: date };
const messages = [{ channelId: channel.channelId, sequence: 1, messageId: 'reply', author: { kind: 'pet', id: 'writer' },
  occurredAt: date, mentions: [], body: `Done. [Inline local](${localRef.uri})`, deliverables: references }];
const streams = new Set();
const requests = [];
const objectRequests = [];
function cors(request, response) {
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  response.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  if (request.method === 'OPTIONS') { response.writeHead(204).end(); return true; }
  return false;
}
const objectServer = createServer((request, response) => {
  if (cors(request, response)) return;
  // A signed public GET uses no cookies. A cross-origin redirect can taint
  // its request origin to null, so object-storage CORS must permit that fetch.
  response.setHeader('Access-Control-Allow-Origin', '*');
  objectRequests.push({ url: request.url, authorization: request.headers.authorization, origin: request.headers.origin });
  response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': "attachment; filename*=UTF-8''cloud.txt" });
  response.end(cloudBytes);
});
const server = createServer((request, response) => {
  if (cors(request, response)) return;
  const url = new URL(request.url, 'http://host');
  requests.push({ path: url.pathname, authorization: request.headers.authorization });
  if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
  if (url.pathname === '/agent-session/artifacts') {
    response.setHeader('Cache-Control', 'no-store');
    if (url.searchParams.get('uri') === localRef.uri) {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': "attachment; filename*=UTF-8''local.bin" });
      response.end(localBytes); return;
    }
    if (url.searchParams.get('uri') === cloudRef.uri) {
      response.writeHead(302, { Location: `http://127.0.0.1:${objectServer.address().port}/signed/cloud.txt?signature=temporary-fixture` }).end(); return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Missing artifact' })); return;
  }
  if (url.pathname === '/events') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': ready\n\n');
    streams.add(response); request.on('close', () => streams.delete(response)); return;
  }
  const values = {
    '/me': { clientId: 'local', scope: 'studio' }, '/pets': { pets: [{ petId: 'writer', name: 'Writer' }] },
    '/scheduler': { schedules: [] }, '/notices': { notices: [] }, '/triggers': { triggers: [], deliveries: [] },
    '/knowledge': { documents: [] }, '/scheduler/events': { events: [] }, '/triggers/events': { events: [] },
    '/channels': { channels: [channel], nextAfter: 1, hasMore: false }, '/dispatch/queues': { queues: [] },
    '/channels/context': { channel, members: [{ participantId: 'human:owner', kind: 'human', id: 'owner', label: 'Owner', joinedAt: date },
      { participantId: 'pet:writer', kind: 'pet', id: 'writer', label: 'Writer', joinedAt: date }], messages,
      viewerParticipantId: 'human:owner', nextAfter: 1, hasMore: false, nextBefore: 1, hasEarlier: false },
    '/channels/sessions': { sessions: [] },
  };
  response.writeHead(url.pathname in values ? 200 : 404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(values[url.pathname] ?? { error: 'Unknown fixture route' }));
});
const downloads = await mkdtemp(resolve(tmpdir(), 'artifact-browser-downloads-'));
let browser;
let vite;
try {
  await new Promise(done => objectServer.listen(0, '127.0.0.1', done));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  vite = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', port, '--strictPort'],
    { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] });
  vite.stderr.on('data', chunk => process.stderr.write(chunk));
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    ready = await fetch(origin).then(response => response.ok).catch(() => false);
    if (ready) break;
    await new Promise(done => setTimeout(done, 100));
  }
  assert.ok(ready, 'isolated Console started');
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHANNEL_BROWSER_EXECUTABLE ?? '/usr/bin/chromium' });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.goto(origin);
  await page.getByLabel('Studio HTTP URL').fill(`http://127.0.0.1:${server.address().port}`);
  await page.getByLabel('Studio bearer token').fill(token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('.connection-state.connected').waitFor();
  await page.getByRole('button', { name: 'Channel', exact: true }).click();
  for (const [label, filename, bytes] of [['Local report', 'local.bin', localBytes], ['Inline local', 'local.bin', localBytes], ['Cloud report', 'cloud.txt', cloudBytes]]) {
    console.log(`Downloading ${label}`);
    const received = page.waitForEvent('download');
    await page.getByRole('button', { name: label, exact: true }).click();
    const download = await received.catch(async error => {
      console.error('Download state', await page.locator('[role="alert"]').allTextContents(), requests, objectRequests);
      throw error;
    });
    assert.equal(download.suggestedFilename(), filename);
    const path = resolve(downloads, `${label.replaceAll(' ', '-')}-${filename}`);
    await download.saveAs(path);
    assert.deepEqual(await readFile(path), bytes);
  }
  assert.equal(objectRequests.length, 1);
  assert.equal(objectRequests[0].authorization, undefined, 'Host bearer is stripped on cross-origin object redirects');
  assert.ok(objectRequests[0].url.includes('signature=temporary-fixture'));
  assert.ok(requests.filter(request => request.path === '/agent-session/artifacts').every(request => request.authorization === `Bearer ${token}`));
  assert.equal(await page.locator('a[href*="signature="]').count(), 0);
  assert.deepEqual(messages[0].deliverables, references);
  assert.deepEqual(failures, []);
  console.log('PASS: authenticated local bytes, Markdown artifact link, COS redirect bytes, and bearer isolation.');
} finally {
  for (const stream of streams) stream.end();
  await browser?.close();
  vite?.kill('SIGTERM');
  await new Promise(done => server.close(done));
  await new Promise(done => objectServer.close(done));
  await rm(downloads, { recursive: true, force: true });
}
