import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const app = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(app, '../..');
const temp = await mkdtemp(resolve(tmpdir(), 'channel-members-browser-'));
const screenshots = process.env.CHANNEL_SCREENSHOTS ?? '/tmp/channel943-screenshots';
const children = [];
let browser;
const launch = (args, cwd, env = {}) => {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env, LANGCHAIN_TRACING_V2: 'false', LANGSMITH_TRACING: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child); child.stderr.on('data', data => process.stderr.write(data)); return child;
};
const until = async (check, label) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error('Timed out: ' + label);
};
try {
  await mkdir(screenshots, { recursive: true });
  const host = launch(['--import', 'tsx/esm', resolve(app, 'tests/support/channelHost.ts')], root,
    { CHANNEL_HOST_TEST_ROOT: temp, CHANNEL_HOST_TEST_MEMBERS: '1', CHANNEL_HOST_TEST_DUPLICATE_NAMES: '1' });
  const ready = await new Promise((resolveReady, reject) => {
    let text = ''; const timeout = setTimeout(() => reject(Error('Host startup timeout')), 20000);
    host.on('exit', code => { clearTimeout(timeout); reject(Error('Host exited ' + code)); });
    host.stdout.on('data', data => { text += data; for (const line of text.split('\n')) {
      if (line.startsWith('{')) { const value = JSON.parse(line); if (value.ready) { clearTimeout(timeout); resolveReady(value); return; } }
    } });
  });
  launch([resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5199', '--strictPort'], app);
  await until(() => fetch('http://127.0.0.1:5199').then(r => r.ok).catch(() => false), 'Console');
  browser = await chromium.launch({ headless: true, ...(process.env.CHANNEL_BROWSER_EXECUTABLE ? { executablePath: process.env.CHANNEL_BROWSER_EXECUTABLE } : {}) });
  const errors = [];
  const connect = async token => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:5199');
    await page.getByLabel('Studio HTTP URL').fill(ready.url);
    await page.getByLabel('Studio bearer token').fill(token);
    await page.getByRole('button', { name: 'CONNECT', exact: true }).click();
    await page.locator('.connection-state.connected').waitFor(); return page;
  };
  const admin = await connect(ready.token);
  await admin.getByRole('button', { name: '+ New Channel', exact: true }).click();
  await admin.getByLabel('Channel title').fill('Shared team');
  await admin.getByLabel('Channel goal').fill('Two users and two Pets');
  await admin.getByLabel('Channel scope').fill('Synthetic browser acceptance');
  await admin.getByRole('dialog', { name: 'Create Channel' }).getByRole('button', { name: 'Create Channel', exact: true }).click();
  await admin.getByRole('heading', { name: 'Shared team', exact: true }).waitFor();
  await admin.locator('.channel-members summary').click();
  await admin.getByLabel('Add Channel member').selectOption('human:colleague');
  await admin.getByRole('button', { name: 'Add member', exact: true }).click();
  await until(() => admin.locator('.channel-members li').count().then(n => n === 4), 'four members');
  const owner = await connect('owner-test-only');
  const colleague = await connect('colleague-test-only');
  for (const page of [owner, colleague]) {
    await page.getByRole('heading', { name: 'Shared team', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'scheduler', exact: true }).count(), 0);
    await page.locator('.channel-members summary').click();
    assert.equal(await page.locator('.channel-members li').count(), 4);
    assert.equal(await page.getByRole('button', { name: 'Add member', exact: true }).count(), 0);
  }
  const send = async (page, body) => {
    await page.locator('.channel-composer textarea').fill(body);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
  };
  await send(owner, 'Owner opening [@Analyst](participant:pet:alpha) and [@Analyst](participant:pet:beta)');
  await until(() => colleague.locator('.channel-message').filter({ hasText: 'Public delivery from alpha.' }).count().then(n => n > 0), 'shared Pet alpha delivery');
  await until(() => colleague.locator('.channel-message').filter({ hasText: 'Public delivery from beta.' }).count().then(n => n > 0), 'shared Pet beta delivery');
  await send(colleague, 'Colleague response [@Owner](participant:human:studio-operator)');
  await until(() => owner.locator('.channel-message').filter({ hasText: 'Colleague response' }).count().then(n => n > 0), 'shared user delivery');
  const ownMessage = owner.locator('.channel-message').filter({ hasText: 'Owner opening' }).first();
  assert.match(await ownMessage.innerText(), /Me/);
  const colleagueMessage = colleague.locator('.channel-message').filter({ hasText: 'Colleague response' }).first();
  assert.match(await colleagueMessage.innerText(), /Me/);
  const api = async (token, route, body) => {
    const response = await fetch(ready.url + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, await response.clone().text()); return response.json();
  };
  const id = (await api('owner-test-only', '/channels')).channels[0].channelId;
  const agent = await api('agent-test-only', '/channels/messages', { channelId: id, body: 'Agent acting for owner' });
  assert.deepEqual(agent.author, { kind: 'human', id: 'studio-operator', actorId: 'fixture-agent' });
  await until(() => owner.locator('.channel-message').filter({ hasText: 'Agent acting for owner' }).count().then(n => n > 0), 'agent history');
  await owner.screenshot({ path: resolve(screenshots, 'owner-desktop.png'), fullPage: true });
  await colleague.setViewportSize({ width: 390, height: 844 });
  await colleague.screenshot({ path: resolve(screenshots, 'colleague-mobile.png'), fullPage: true });
  assert.ok(await colleague.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await admin.locator('.channel-members li').filter({ hasText: 'human:colleague' }).getByRole('button', { name: 'Remove', exact: true }).click();
  await until(() => colleague.locator('.channel-message').count().then(n => n === 0), 'revoked user clears visible history');
  assert.deepEqual(errors, []);
  console.log('PASS: real HTTP/Host Console member management, two users/two Pets, scoped credentials, agent ownership, shared history, revocation and mobile layout. Screenshots: ' + screenshots);
} finally {
  await browser?.close();
  for (const child of children.reverse()) { child.kill('SIGTERM'); await new Promise(resolveExit => { if (child.exitCode !== null) return resolveExit(); child.once('exit', resolveExit); setTimeout(resolveExit, 3000); }); }
  await rm(temp, { recursive: true, force: true });
}
