import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Real Host, Channel, Studio HTTP and Console; only the graph's reply is deterministic.
const app = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(app, '../..');
const screenshotDir = process.env.PET_SESSION_SCREENSHOTS ?? '/tmp/pet-session-console-screenshots';
const hostRoot = await mkdtemp(resolve(tmpdir(), 'pet-session-console-host-'));
await mkdir(screenshotDir, { recursive: true });
const children = [];
let browser;
const spawnProcess = (args, cwd, env = {}) => {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env, LANGCHAIN_TRACING_V2: 'false', LANGSMITH_TRACING: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stderr.on('data', data => process.stderr.write(data));
  return child;
};
const waitFor = async (check, label) => {
  for (let i = 0; i < 150; i++) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
};

try {
  const host = spawnProcess(['--import', 'tsx/esm', resolve(app, 'tests/support/channelHost.ts')], root, { CHANNEL_HOST_TEST_ROOT: hostRoot });
  const ready = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Host startup timed out.')), 20000);
    host.on('exit', code => { clearTimeout(timer); reject(new Error(`Host exited ${code}`)); });
    host.stdout.on('data', data => {
      buffer += data;
      for (const line of buffer.split('\n')) {
        if (!line.startsWith('{')) continue;
        const value = JSON.parse(line);
        if (value.ready) { clearTimeout(timer); resolve(value); return; }
      }
    });
  });
  const vite = spawnProcess([resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5199', '--strictPort'], app);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Console startup timed out.')), 15000);
    vite.on('exit', code => { clearTimeout(timer); reject(new Error(`Console exited ${code}`)); });
    vite.stdout.on('data', data => { if (String(data).includes('http://127.0.0.1:5199')) { clearTimeout(timer); resolve(); } });
  });
  const api = async path => {
    const response = await fetch(`${ready.url}${path}`, { headers: { Authorization: `Bearer ${ready.token}` } });
    assert.equal(response.status, 200, path);
    return response.json();
  };
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  const writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST') writes.push(new URL(request.url()).pathname); });
  await page.goto('http://127.0.0.1:5199');
  await page.getByLabel('Studio HTTP URL').fill(ready.url);
  await page.getByLabel('Studio bearer token').fill(ready.token);
  await page.getByRole('button', { name: 'CONNECT', exact: true }).click();
  await page.locator('.connection-state.connected').waitFor();
  await page.getByRole('button', { name: 'channel', exact: true }).click();
  await page.getByRole('button', { name: '+ New Channel', exact: true }).click();
  await page.getByLabel('Channel title').fill('Session reading');
  await page.getByLabel('Channel goal').fill('Read Pet sessions from the Console.');
  await page.getByLabel('Channel scope').fill('Observe and answer reviews only.');
  await page.getByRole('button', { name: 'Create Channel', exact: true }).click();
  await page.getByRole('heading', { name: 'Session reading', exact: true }).waitFor();
  const channelId = (await api('/channels')).channels[0].channelId;
  const executions = async () => (await api(`/channels/executions?channelId=${channelId}`)).executions;
  const outputs = async () => (await api(`/channels/context?channelId=${channelId}&limit=200`)).history.entries.filter(item => item.kind === 'message' && item.source);

  await page.getByLabel('Channel recipient').selectOption('pet:alpha');
  await page.getByLabel('Message', { exact: true }).fill('Investigate the current scope.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await waitFor(async () => (await outputs()).length === 1, 'alpha output');
  await page.getByLabel('Channel recipient').selectOption('pet:beta');
  await page.getByLabel('Message', { exact: true }).fill('review');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await waitFor(async () => (await executions()).some(item => item.petId === 'beta' && item.state === 'waiting'), 'beta waits for review');
  const waiting = (await executions()).find(item => item.petId === 'beta');

  // Open the waiting execution's own session and answer its current review.
  const activity = page.locator('#execution-' + waiting.executionId);
  await activity.getByText('review requested', { exact: true }).waitFor();
  const writesBeforeReading = writes.length;
  await activity.getByRole('button', { name: 'View session', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: /session/ });
  await viewer.getByText('Waiting for review', { exact: true }).waitFor();
  await viewer.getByText('Authorize fixture tool?', { exact: true }).waitFor();
  await viewer.getByText(waiting.sessionId, { exact: true }).first().waitFor();
  assert.equal(await viewer.getByLabel('Message', { exact: true }).count(), 0, 'the reader has no chat composer');
  assert.equal(writes.length, writesBeforeReading, 'reading a session sends nothing');
  await page.screenshot({ path: resolve(screenshotDir, '01-session-review.png') });
  await viewer.getByRole('button', { name: 'Approve', exact: true }).click();
  await waitFor(async () => (await executions()).find(item => item.executionId === waiting.executionId)?.state === 'completed', 'approved dispatch continues and completes');
  await waitFor(async () => (await outputs()).some(item => item.author.id === 'beta'), 'beta output delivered to the Channel');
  await viewer.getByText('Idle', { exact: true }).waitFor();
  await viewer.getByText('Public delivery from beta.', { exact: false }).first().waitFor();
  assert.equal(await viewer.getByRole('button', { name: 'Approve', exact: true }).count(), 0, 'an answered review is no longer offered');
  assert.deepEqual(writes.slice(writesBeforeReading), ['/pet-sessions/review'], 'the review answer is the only write');
  await page.screenshot({ path: resolve(screenshotDir, '02-session-after-review.png') });
  await page.keyboard.press('Escape');
  await viewer.waitFor({ state: 'detached' });

  // A finished execution is still readable at any time.
  const finished = (await executions()).find(item => item.petId === 'alpha');
  await page.locator('#execution-' + finished.executionId).getByRole('button', { name: 'View session', exact: true }).click();
  await viewer.getByText('Public delivery from alpha.', { exact: false }).first().waitFor();
  await viewer.getByText('Idle', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: resolve(screenshotDir, '03-session-mobile.png') });
  await viewer.getByRole('button', { name: 'Close session view' }).click();
  await viewer.waitFor({ state: 'detached' });
  assert.equal((await executions()).length, 2, 'reading sessions created no execution');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', modelCalls: 0, screenshots: screenshotDir }));
} finally {
  await browser?.close();
  for (const child of children) { if (child.exitCode === null) child.kill('SIGTERM'); }
  await Promise.all(children.map(child => child.exitCode !== null ? undefined : new Promise(resolve => child.once('exit', resolve))));
  await rm(hostRoot, { recursive: true, force: true });
}
