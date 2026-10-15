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
      for (const line of buffer.split('\n').slice(0, -1)) {
        if (!line.startsWith('{"ready"')) continue;
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
  browser = await chromium.launch({ headless: true, ...(process.env.CHANNEL_BROWSER_EXECUTABLE ? { executablePath: process.env.CHANNEL_BROWSER_EXECUTABLE } : {}) });
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
  await page.getByRole('checkbox', { name: 'Alpha', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Beta', exact: true }).check();
  await page.getByRole('button', { name: 'Create Channel', exact: true }).click();
  await page.getByRole('heading', { name: 'Session reading', exact: true }).waitFor();
  const channelId = (await api('/channels')).channels[0].channelId;
  const sessions = async () => (await api(`/channels/sessions?channelId=${channelId}`)).sessions;
  const outputs = async () => (await api(`/channels/context?channelId=${channelId}&limit=200`)).messages.filter(item => item.author.kind === 'pet');

  const mentionList = page.getByRole('listbox', { name: 'Members to mention' });
  const address = async (participantId, text) => {
    await page.getByLabel('Message', { exact: true }).click();
    await page.keyboard.type('@');
    await mentionList.getByRole('option').filter({ hasText: participantId }).click();
    await page.keyboard.type(text);
  };
  await address('pet:alpha', 'Investigate the current state.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await waitFor(async () => (await outputs()).length === 1, 'alpha output');
  await address('pet:beta', 'review');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const waiting = await waitFor(async () => (await sessions()).find(item => item.petId === 'beta' && item.registered), 'beta session registered');

  // Open Beta's Channel session from the member list and answer its current review there.
  const member = page.getByRole('region', { name: 'Channel members' }).locator('.channel-member').filter({ hasText: 'pet:beta' });
  const writesBeforeReading = writes.length;
  await member.getByRole('button', { name: 'View session', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: /session/ });
  await viewer.getByText('Waiting for review', { exact: true }).waitFor();
  await viewer.getByText('Authorize fixture tool?', { exact: true }).waitFor();
  await viewer.getByText(waiting.sessionId, { exact: true }).first().waitFor();
  assert.equal(await viewer.getByLabel('Message', { exact: true }).count(), 0, 'the reader has no chat composer');
  assert.equal(writes.length, writesBeforeReading, 'reading a session sends nothing');
  await page.screenshot({ path: resolve(screenshotDir, '01-session-review.png') });
  await viewer.getByRole('button', { name: 'Approve', exact: true }).click();
  await waitFor(async () => (await outputs()).some(item => item.author.id === 'beta'), 'approved dispatch continues and Beta posts to the Channel');
  await viewer.getByText('Idle', { exact: true }).waitFor();
  await viewer.getByText('Public delivery from beta.', { exact: false }).first().waitFor();
  assert.equal(await viewer.getByRole('button', { name: 'Approve', exact: true }).count(), 0, 'an answered review is no longer offered');
  assert.deepEqual(writes.slice(writesBeforeReading), ['/pet-sessions/review'], 'the review answer is the only write');
  await page.screenshot({ path: resolve(screenshotDir, '02-session-after-review.png') });
  await page.keyboard.press('Escape');
  await viewer.waitFor({ state: 'detached' });

  // A Pet's message opens the session it was written in.
  const alphaMessage = page.locator('[data-message-id="' + (await outputs()).find(item => item.author.id === 'alpha').messageId + '"]');
  await alphaMessage.getByRole('button', { name: 'View Alpha session', exact: true }).click();
  await viewer.getByText('Public delivery from alpha.', { exact: false }).first().waitFor();
  await viewer.getByText('Idle', { exact: true }).waitFor();
  await viewer.getByText((await sessions()).find(item => item.petId === 'alpha').sessionId, { exact: true }).first().waitFor();
  await page.setViewportSize({ width: 390, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: resolve(screenshotDir, '03-session-mobile.png') });
  await viewer.getByRole('button', { name: 'Close session view' }).click();
  await viewer.waitFor({ state: 'detached' });
  assert.equal((await outputs()).length, 2, 'reading sessions created no message');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', modelCalls: 0, screenshots: screenshotDir }));
} finally {
  await browser?.close();
  for (const child of children) { if (child.exitCode === null) child.kill('SIGTERM'); }
  await Promise.all(children.map(child => child.exitCode !== null ? undefined : new Promise(resolve => child.once('exit', resolve))));
  await rm(hostRoot, { recursive: true, force: true });
}
