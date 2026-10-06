import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Frontend-only fixture: no Studio Host, Pet, model, or dispatch is started.
const app = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(app, '../..');
const screenshots = process.env.CHANNEL_SCREENSHOTS ?? '/tmp/channel-message-fullscreen-screenshots';
const port = process.env.CHANNEL_MESSAGE_TEST_PORT ?? '5208';
const date = '2026-10-06T00:00:00Z';
const channel = { kind: 'revision', channelId: 'fixture', sequence: 1, title: 'Message reading fixture', goal: 'Inspect public Markdown', scope: 'Frontend only', reason: 'created', occurredAt: date, author: { kind: 'human', id: 'owner' }, references: [] };
const participants = [{ participantId: 'pet:analyst', kind: 'pet', id: 'analyst', label: 'Analyst' }];
const originalBody = '# Public evidence\n\n[Analyst](participant:pet:analyst) · 中文🙂\n\n' +
  '| Check | Result |\n| --- | --- |\n| Reader | Passed |\n\n```ts\nconst wide = "' + 'evidence'.repeat(120) + '";\n```\n\n' +
  Array.from({ length: 70 }, (_, i) => 'Reading paragraph ' + i + '. ' + 'Public evidence remains read-only. '.repeat(4)).join('\n\n') +
  '\n\n[Unsafe](javascript:alert(1))\n\n<script>window.bad = true</script>';
const makeMessage = (id, sequence, body) => ({ kind: 'message', channelId: channel.channelId, messageId: id, sequence, body, revision: 1,
  author: { kind: 'pet', id: 'analyst' }, occurredAt: date, mentions: [], artifacts: [] });
const entries = Array.from({ length: 20 }, (_, i) => makeMessage('older-' + i, i + 2, 'Older evidence ' + i + '. '.repeat(40)));
entries.push(makeMessage('long', 22, originalBody));
for (let i = 0; i < 20; i++) entries.push(makeMessage('newer-' + i, 23 + i, 'Newer evidence ' + i + '. '.repeat(40)));
const streams = new Set();
const writes = [];
const requests = [];
const server = createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
  const path = new URL(request.url, 'http://fixture').pathname;
  requests.push(path);
  if (request.method !== 'GET') { writes.push(path); response.writeHead(405).end(); return; }
  if (path === '/events') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': fixture ready\n\n');
    streams.add(response); request.on('close', () => streams.delete(response)); return;
  }
  const values = {
    '/pets': { pets: [{ petId: 'analyst', name: 'Analyst' }] }, '/scheduler': { schedules: [] }, '/notices': { notices: [] },
    '/triggers': { triggers: [], deliveries: [] }, '/knowledge': { documents: [] }, '/scheduler/events': { events: [] }, '/triggers/events': { events: [] },
    '/channels': { channels: [channel], nextAfter: 1, hasMore: false }, '/dispatch/queues': { queues: [] },
    '/channels/context': { channel, participants, viewerParticipantId: 'human:owner', sessions: [], history: { entries, nextAfter: entries.at(-1).sequence, hasMore: false } },
    '/channels/executions': { executions: [], nextAfter: 0, hasMore: false }, '/channels/interrupts': { notifications: [], nextAfter: 0, hasMore: false },
  };
  response.writeHead(path in values ? 200 : 404, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(values[path] ?? { error: 'Unknown fixture route' }));
});
let browser;
let vite;
const until = async (check, label) => {
  for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error('Timed out: ' + label);
};
try {
  await mkdir(screenshots, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  vite = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', port, '--strictPort'], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] });
  vite.stderr.on('data', data => process.stderr.write(data));
  await until(() => fetch('http://127.0.0.1:' + port).then(r => r.ok).catch(() => false), 'isolated frontend');
  browser = await chromium.launch({ headless: true, ...(process.env.CHANNEL_BROWSER_EXECUTABLE ? { executablePath: process.env.CHANNEL_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + port);
  await page.getByLabel('Studio HTTP URL').fill(url);
  await page.getByLabel('Studio bearer token').fill('synthetic-only-token');
  await page.getByRole('button', { name: 'CONNECT', exact: true }).click();
  await page.locator('.connection-state.connected').waitFor();
  await page.getByRole('button', { name: 'channel', exact: true }).click();
  const message = page.locator('[data-message-id="long"]');
  const expand = message.getByRole('button', { name: 'View full screen', exact: true });
  const timeline = page.locator('.channel-timeline-scroll');
  const dialog = page.getByRole('dialog', { name: 'Message from Analyst', exact: true });
  const close = page.getByRole('button', { name: 'Close full-screen message', exact: true });
  const readPosition = () => timeline.evaluate(node => node.scrollTop);
  const isExpandFocused = () => expand.evaluate(node => document.activeElement === node);
  const sizes = [{ width: 1440, height: 900 }, { width: 390, height: 300 }, { width: 320, height: 200 }];
  for (const size of sizes) {
    console.log('Checking viewport ' + size.width + 'x' + size.height);
    await page.setViewportSize(size);
    await expand.scrollIntoViewIfNeeded();
    const before = await readPosition();
    const documentBefore = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
    await expand.focus();
    assert.equal(await expand.evaluate(node => getComputedStyle(node).opacity), '1', 'entry is discoverable without hover');
    await page.keyboard.press('Enter');
    await dialog.waitFor();
    assert.equal(await close.evaluate(node => document.activeElement === node), true, 'initial focus is Close');
    assert.equal(await dialog.getByRole('heading', { name: 'Public evidence' }).count(), 1);
    assert.equal(await dialog.locator('.channel-mention').innerText(), '@Analyst');
    assert.equal(await dialog.locator('table').count(), 1);
    assert.equal(await dialog.locator('script').count(), 0);
    assert.equal(await dialog.locator('a[href^="javascript:"]').count(), 0);
    assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth), true, 'no overlay horizontal overflow');
    const box = await dialog.boundingBox();
    assert.deepEqual({ x: box.x, y: box.y, width: box.width, height: box.height }, { x: 0, y: 0, ...size });
    const scroll = dialog.locator('.channel-message-viewer-scroll');
    assert.equal(await scroll.evaluate(node => node.scrollHeight > node.clientHeight), true);
    await scroll.hover({ position: { x: 5, y: 12 } });
    await page.waitForTimeout(250); // Let wheel targeting settle after resize and modal opening.
    await page.mouse.wheel(0, 450);
    await until(() => scroll.evaluate(node => node.scrollTop > 0), 'reader wheel');
    assert.equal(await readPosition(), before, 'reader wheel does not move Timeline');
    assert.deepEqual(await page.evaluate(() => ({ x: scrollX, y: scrollY })), documentBefore, 'reader wheel does not move document');
    await scroll.evaluate(node => { node.scrollTop = 0; });
    const code = dialog.locator('pre');
    assert.equal(await code.evaluate(node => node.scrollWidth > node.clientWidth), true);
    await code.evaluate(node => { node.scrollLeft = 200; });
    assert.ok(await code.evaluate(node => node.scrollLeft > 0), 'wide code independently scrolls');
    await close.focus(); await page.keyboard.press('Shift+Tab');
    assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, 'backward focus stays modal');
    await page.keyboard.press('Tab');
    assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, 'forward focus stays modal');
    // Clicking unused reader space keeps the full-screen reader open; only Close/Esc dismiss.
    await dialog.click({ position: { x: 2, y: size.height - 2 } });
    assert.equal(await dialog.isVisible(), true);
    await scroll.evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: resolve(screenshots, 'message-' + size.width + 'x' + size.height + '.png') });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await isExpandFocused(), true);
    assert.equal(await readPosition(), before);
    assert.deepEqual(await page.evaluate(() => ({ x: scrollX, y: scrollY })), documentBefore);
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Enter'); await dialog.waitFor(); await close.click(); await dialog.waitFor({ state: 'hidden' });
      assert.equal(await isExpandFocused(), true); assert.equal(await readPosition(), before);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expand.scrollIntoViewIfNeeded();
  const beforeUpdate = await readPosition();
  await expand.click(); await dialog.waitFor();
  entries.find(item => item.messageId === 'long').body = originalBody + '\n\nUpdated stored body.';
  entries.push(makeMessage('incoming', 50, 'New message during full-screen reading.'));
  for (const stream of streams) stream.write('data: ' + JSON.stringify({ type: 'channel.message', source: 'channel', occurredAt: date, payload: { channelId: channel.channelId } }) + '\n\n');
  await page.locator('[data-message-id="incoming"]').waitFor({ state: 'attached' });
  assert.equal(await message.getByText('Updated stored body.', { exact: true }).count(), 1);
  assert.equal(await dialog.getByText('Updated stored body.', { exact: true }).count(), 0, 'open reader holds a stable snapshot');
  assert.equal(await readPosition(), beforeUpdate, 'background refresh cannot move reading position');
  await close.click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal(await readPosition(), beforeUpdate);
  await expand.click(); await dialog.waitFor();
  assert.equal(await dialog.getByText('Updated stored body.', { exact: true }).count(), 1, 'reopening shows latest stored body');
  await close.click();
  assert.deepEqual(writes, [], 'reading never posts messages or dispatches');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', fixture: 'frontend + synthetic HTTP/SSE only', sizes, writes, screenshots,
    coverage: ['discoverable keyboard entry', 'shared safe Markdown/mentions/table', 'full viewport', 'vertical reader and horizontal code scrolling',
      'native modal focus containment', 'Esc/Close restore focus, Timeline and document scrolling', 'blank-space click stays open', 'repeat opening under StrictMode', 'stable snapshot during SSE update; latest on reopen', 'no write or dispatch'] }));
} finally {
  await browser?.close();
  if (vite && vite.exitCode === null) { vite.kill('SIGTERM'); await new Promise(resolve => vite.once('exit', resolve)); }
  for (const stream of streams) stream.end();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
