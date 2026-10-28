import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Isolated Studio fixture: no real credentials, Pet or project files.
const app = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(app, '../..');
const date = '2026-10-27T00:00:00Z';
const docs = {
  'PROJECT.md': '# Toolbox 项目 Wiki\n\n[本页](#目标)\n\n## 目标\n\n[架构](architecture.md#核心说明)\n\n[源码](../README.md)\n\n| 项 | 内容 |\n| --- | --- |\n| 类别 | Wiki |',
  'architecture.md': '# 架构\n\n## 核心说明\n\n[返回](PROJECT.md)\n\n<script>window.bad = true</script>',
};
const documents = Object.entries(docs).map(([path, content]) => ({ path, title: path, size: content.length, modifiedAt: date }));
const channel = { channelId: 'fixture', title: 'Toolbox', description: 'Shared project work', createdBy: { kind: 'human', id: 'local' }, createdAt: date, updatedAt: date };
const members = [{ participantId: 'human:local', kind: 'human', id: 'local', label: 'Local', joinedAt: date }];
const reads = [];
const streams = new Set();
let server2;
let holdNextDocument = false;
let heldDocument;
let holdNextList = false;
let nextListStatus = 200;
let heldList;
let extraPage = false;
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', '*');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  if (url.pathname === '/events') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': connected\n\n');
    streams.add(response); request.on('close', () => streams.delete(response)); return;
  }
  const isOtherHost = server2?.listening && request.socket.localPort === server2.address().port;
  const isNewToken = request.headers.authorization === 'Bearer new-token';
  const currentDocs = isOtherHost ? { 'PROJECT.md': '# 新主机 Wiki', 'host.md': '# 新主机页面' }
    : isNewToken ? { 'PROJECT.md': '# 新凭据 Wiki', 'new.md': '# 新凭据页面' } : extraPage ? { ...docs, 'fresh.md': '# 最新页面' } : docs;
  const currentDocuments = Object.entries(currentDocs).map(([path, content]) => ({ path, title: path, size: content.length, modifiedAt: date }));
  const send = (body) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
  const values = {
    '/me': { clientId: 'local', scope: request.headers.authorization === 'Bearer client-only-token' ? 'client' : 'studio' }, '/pets': { pets: [] }, '/scheduler': { schedules: [] },
    '/notices': { notices: [] }, '/triggers': { triggers: [], deliveries: [] }, '/knowledge': { documents: currentDocuments },
    '/scheduler/events': { events: [] }, '/triggers/events': { events: [] }, '/channels': { channels: [channel], nextAfter: 1, hasMore: false },
    '/channels/context': { channel, members, messages: [], viewerParticipantId: 'human:local', nextAfter: 0, nextBefore: 0, hasMore: false, hasEarlier: false },
    '/channels/sessions': { sessions: [] },
    '/dispatch/queues': { queues: [] },
  };
  if (url.pathname === '/knowledge/document') {
    const path = url.searchParams.get('path'); reads.push(path);
    if (!(path in currentDocs)) { response.writeHead(404); response.end('{}'); return; }
    const body = { document: { ...currentDocuments.find((doc) => doc.path === path), content: currentDocs[path] } };
    if (holdNextDocument) { holdNextDocument = false; heldDocument = () => send(body); return; }
    send(body); return;
  }
  if (url.pathname === '/knowledge' && holdNextList) {
    holdNextList = false;
    const body = values[url.pathname];
    const status = nextListStatus; nextListStatus = 200;
    if (status === 200) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.flushHeaders(); }
    heldList = () => { if (status !== 200) response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); }; return;
  }
  response.writeHead(url.pathname in values ? 200 : 404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(values[url.pathname] ?? { error: 'fixture route not found' }));
});
let browser; let vite;
const until = async (check, label) => {
  for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise((done) => setTimeout(done, 100)); }
  throw Error(`Timed out: ${label}`);
};
try {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  server2 = createServer(server.listeners('request')[0]);
  await new Promise((done) => server2.listen(0, '127.0.0.1', done));
  vite = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5219', '--strictPort'], { cwd: app, stdio: 'pipe' });
  vite.stderr.on('data', (data) => process.stderr.write(data));
  await until(() => fetch('http://127.0.0.1:5219').then((r) => r.ok).catch(() => false), 'frontend');
  browser = await chromium.launch({ headless: true, ...(process.env.KNOWLEDGE_BROWSER_EXECUTABLE ? { executablePath: process.env.KNOWLEDGE_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:5219');
  await page.getByLabel('Studio HTTP URL').fill(`http://127.0.0.1:${server.address().port}`);
  await page.getByLabel('Studio bearer token').fill('synthetic-only-token');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('.connection-state.connected').waitFor();
  await page.getByRole('heading', { name: 'Toolbox', exact: true }).waitFor();
  await page.getByRole('button', { name: 'View project Wiki', exact: true }).click();
  await page.getByRole('heading', { name: 'Toolbox 项目 Wiki' }).waitFor();
  assert.equal(await page.locator('.knowledge-markdown table').count(), 1);
  assert.equal(await page.getByRole('link', { name: '源码' }).count(), 0);
  // A delayed different page must not overwrite a newer same-page anchor choice,
  // including a second click on the same anchor.
  await page.getByRole('link', { name: '本页' }).click();
  holdNextDocument = true;
  await page.getByRole('link', { name: '架构' }).click();
  await until(() => !!heldDocument, 'delayed document request');
  await page.getByRole('link', { name: '本页' }).click();
  heldDocument(); heldDocument = undefined;
  await page.waitForTimeout(200);
  assert.equal(await page.getByRole('heading', { name: 'Toolbox 项目 Wiki' }).count(), 1, 'stale different document did not override anchor navigation');
  await page.getByRole('link', { name: '架构' }).click();
  await page.getByRole('heading', { name: '架构', exact: true }).waitFor();
  assert.equal(await page.locator('#核心说明').count(), 1);
  await page.getByRole('link', { name: '返回' }).click();
  await page.getByRole('heading', { name: 'Toolbox 项目 Wiki' }).waitFor();
  assert.deepEqual(reads, ['PROJECT.md', 'architecture.md', 'architecture.md', 'PROJECT.md']);
  // A late 404 from Refresh must not hide a newer page selection.
  holdNextList = true; nextListStatus = 404;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await until(() => !!heldList, 'delayed missing-list response');
  await page.getByRole('link', { name: '架构' }).click();
  await page.getByRole('heading', { name: '架构', exact: true }).waitFor();
  heldList(); heldList = undefined;
  await page.waitForTimeout(200);
  assert.equal(await page.getByRole('heading', { name: '架构', exact: true }).count(), 1, 'stale 404 did not hide newer page selection');
  await page.getByRole('link', { name: '返回' }).click();
  await page.getByRole('heading', { name: 'Toolbox 项目 Wiki' }).waitFor();
  // A background snapshot that began first cannot overwrite a later manual refresh.
  holdNextList = true;
  for (const stream of streams) stream.write(`data: ${JSON.stringify({ source: 'notice', type: 'notice.recorded', occurredAt: date })}\n\n`);
  await until(() => !!heldList, 'delayed background list');
  extraPage = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: /fresh.md/ }).waitFor();
  heldList(); heldList = undefined;
  await page.waitForTimeout(200);
  assert.equal(await page.getByRole('button', { name: /fresh.md/ }).count(), 1, 'old background snapshot did not override manual refresh');
  // Conversely, a newer background snapshot wins over a slower manual refresh.
  holdNextList = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await until(() => !!heldList, 'delayed manual list');
  extraPage = false;
  for (const stream of streams) stream.write(`data: ${JSON.stringify({ source: 'notice', type: 'notice.recorded', occurredAt: date })}\n\n`);
  await until(async () => await page.getByRole('button', { name: /fresh.md/ }).count() === 0, 'new background list');
  heldList(); heldList = undefined;
  await page.waitForTimeout(200);
  assert.equal(await page.getByRole('button', { name: /fresh.md/ }).count(), 0, 'old manual refresh did not override background snapshot');
  assert.deepEqual(errors, []);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  // Same endpoint, different credentials: the old list can arrive after the new snapshot.
  await page.setViewportSize({ width: 1280, height: 900 });
  holdNextList = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await until(() => !!heldList, 'delayed old credential list');
  await page.getByRole('button', { name: 'Connection', exact: true }).click();
  await page.getByLabel('Studio bearer token').fill('new-token');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('heading', { name: '新凭据 Wiki' }).waitFor();
  heldList(); heldList = undefined;
  await page.waitForTimeout(200);
  assert.equal(await page.getByRole('heading', { name: '新凭据 Wiki' }).count(), 1, 'old credentials did not replace the new document');
  assert.equal(await page.getByRole('button', { name: /new.md/ }).count(), 1, 'new credential list remains visible');
  assert.equal(await page.getByRole('button', { name: /architecture.md/ }).count(), 0, 'old credential list was discarded');
  // Different Host, same token: an old list and document must never cross the connection.
  holdNextList = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await until(() => !!heldList, 'delayed old Host list');
  await page.getByRole('button', { name: 'Connection', exact: true }).click();
  await page.getByLabel('Studio HTTP URL').fill(`http://127.0.0.1:${server2.address().port}`);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('heading', { name: '新主机 Wiki' }).waitFor();
  heldList(); heldList = undefined;
  await page.waitForTimeout(200);
  assert.equal(await page.getByRole('heading', { name: '新主机 Wiki' }).count(), 1, 'old Host did not replace the new document');
  assert.equal(await page.getByRole('button', { name: /host.md/ }).count(), 1, 'new Host list remains visible');
  assert.equal(await page.getByRole('button', { name: /new.md/ }).count(), 0, 'old Host list was discarded');
  // A genuine access denial must clear content from the previous permission state.
  holdNextList = true; nextListStatus = 403;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await until(() => !!heldList, 'denied-list response');
  heldList(); heldList = undefined;
  await page.getByText('Knowledge access is no longer available.').waitFor();
  assert.equal(await page.getByRole('heading', { name: '新主机 Wiki' }).count(), 0, 'denied access clears old content');
  const client = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await client.goto('http://127.0.0.1:5219');
  await client.getByLabel('Studio HTTP URL').fill(`http://127.0.0.1:${server.address().port}`);
  await client.getByLabel('Studio bearer token').fill('client-only-token');
  await client.getByRole('button', { name: 'Connect', exact: true }).click();
  await client.getByRole('heading', { name: 'Toolbox', exact: true }).waitFor();
  assert.equal(await client.getByRole('button', { name: 'View project Wiki', exact: true }).count(), 0, 'Channel-only client has no global Wiki entry');
  assert.equal(await client.getByRole('button', { name: 'Knowledge', exact: true }).count(), 0, 'Channel-only client has no Knowledge page');
  console.log('Wiki browser fixture: Channel entry, client boundary, Markdown, safe navigation, mobile layout and delayed-response races passed');
} finally {
  await browser?.close(); vite?.kill(); for (const stream of streams) stream.destroy();
  await Promise.all([new Promise((done) => server.close(done)), new Promise((done) => server2?.close(done))]);
}
