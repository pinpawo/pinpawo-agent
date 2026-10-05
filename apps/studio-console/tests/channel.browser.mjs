import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const app = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(app, '../..');
const screenshotDir = process.env.CHANNEL_SCREENSHOTS ?? '/tmp/channel-console-screenshots';
const hostRoot = await mkdtemp(resolve(tmpdir(), 'channel-console-host-'));
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

const startHost = async (port = 0) => {
  const host = spawnProcess(['--import', 'tsx/esm', resolve(app, 'tests/support/channelHost.ts')], root,
    { CHANNEL_HOST_TEST_ROOT: hostRoot, CHANNEL_HOST_TEST_PORT: String(port) });
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
  return { host, ready };
};
try {
  const { host, ready } = await startHost();
  const vite = spawnProcess([resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5199', '--strictPort'], app);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Console startup timed out.')), 15000);
    vite.on('exit', code => { clearTimeout(timer); reject(new Error(`Console exited ${code}`)); });
    vite.stdout.on('data', data => {
      if (String(data).includes('http://127.0.0.1:5199')) { clearTimeout(timer); resolve(); }
    });
  });
  await waitFor(async () => fetch('http://127.0.0.1:5199').then(response => response.ok).catch(() => false), 'Console startup');
  const api = async path => {
    const response = await fetch(`${ready.url}${path}`, { headers: { Authorization: `Bearer ${ready.token}` } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const apiPost = async (path, body) => {
    const response = await fetch(`${ready.url}${path}`, { method: 'POST',
      headers: { Authorization: `Bearer ${ready.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok(response.ok); return response.json();
  };
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:5199');
  await page.getByLabel('Studio HTTP URL').fill(ready.url);
  await page.getByLabel('Studio bearer token').fill(ready.token);
  await page.getByRole('button', { name: 'CONNECT', exact: true }).click();
  await page.locator('.connection-state.connected').waitFor();
  await page.getByRole('button', { name: 'channel', exact: true }).click();
  const create = async title => {
    await page.getByRole('button', { name: '+ New Channel', exact: true }).click();
    await page.getByLabel('Channel title').fill(title);
    await page.getByLabel('Channel goal').fill('Improve customer records with auditable public deliveries.');
    await page.getByLabel('Channel scope').fill('Inspect one record; retain evidence and ask for approval when needed.');
    await page.getByRole('dialog', { name: 'Create Channel' }).evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    await page.getByRole('heading', { name: title, exact: true }).waitFor();
  };
  await create('Customer records');
  let listed = await api('/channels');
  assert.equal(listed.channels.length, 1, 'duplicate form submission creates one Channel');
  const firstId = listed.channels[0].channelId;
  const context = () => api(`/channels/context?channelId=${firstId}&limit=200`);
  const executions = () => api(`/channels/executions?channelId=${firstId}`);
  const publicMessages = async () => (await context()).history.entries.filter(item => item.kind === 'message' && item.source);
  assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
  await page.getByLabel('Message', { exact: true }).fill('A note mentioning @beta without execution.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('A note mentioning @beta without execution.', { exact: true }).waitFor();
  assert.equal((await executions()).executions.length, 0);
  await page.getByLabel('Channel recipient').selectOption('pet:alpha');
  await page.getByLabel('Message', { exact: true }).fill('Investigate the current scope.');
  await page.locator('.channel-composer').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
  await waitFor(async () => (await publicMessages()).length === 1, 'first completed output');
  await page.getByText('Full handoff evidence:', { exact: false }).first().waitFor();
  assert.equal((await executions()).executions.length, 1, 'duplicate form submission starts one invocation');
  const originalSession = (await context()).sessions.find(item => item.petId === 'alpha').sessionId;
  await page.getByRole('button', { name: 'Reply to Alpha', exact: true }).first().click();
  assert.equal(await page.getByLabel('Channel recipient').isDisabled(), false);
  assert.equal(await page.getByLabel('Channel recipient').inputValue(), '', 'reply context does not auto-address anyone');
  await page.getByLabel('Channel recipient').selectOption('pet:alpha');
  await page.getByLabel('Message', { exact: true }).fill('Continue with the same evidence.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await waitFor(async () => (await publicMessages()).length === 2, 'reply completed');
  assert.equal((await publicMessages())[1].source.sessionId, originalSession);
  assert.ok((await publicMessages())[1].body.includes('Reply to Channel message'));
  await page.getByLabel('Channel recipient').selectOption('pet:beta');
  await page.getByLabel('Message', { exact: true }).fill('Read prior public evidence and review the delivery.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await waitFor(async () => (await publicMessages()).length === 3, 'second Pet completed');
  assert.ok((await publicMessages())[2].body.includes('Prior public deliveries read: 2.'));
  assert.notEqual((await context()).sessions.find(item => item.petId === 'beta').sessionId, originalSession);
  await page.screenshot({ path: resolve(screenshotDir, '01-channel-timeline.png'), fullPage: true });

  await create('Separate investigation');
  assert.equal(await page.getByLabel('Channel recipient').inputValue(), '', 'new Channel requires a fresh explicit Pet selection');
  listed = await api('/channels');
  assert.equal(listed.channels.length, 2);
  const secondId = listed.channels.find(item => item.title === 'Separate investigation').channelId;
  await page.getByLabel('Channel recipient').selectOption('pet:alpha');
  await page.getByLabel('Message', { exact: true }).fill('Check the isolated Channel.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const other = await waitFor(async () => {
    const value = await api(`/channels/context?channelId=${secondId}`);
    return value.history.entries.some(item => item.source) && value;
  }, 'other Channel output');
  assert.notEqual(other.sessions[0].sessionId, originalSession);
  assert.ok(other.history.entries.find(item => item.source).body.includes('Prior public deliveries read: 0.'));
  await page.locator('.channel-list button').filter({ hasText: 'Customer records' }).click();
  await page.getByRole('heading', { name: 'Customer records', exact: true }).waitFor();
  await page.getByLabel('Channel recipient').selectOption('pet:alpha');
  await page.getByLabel('Message', { exact: true }).fill('fail-provider');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await waitFor(async () => (await executions()).executions.some(item => item.state === 'failed'), 'failed execution persisted');
  await page.locator('.channel-executions').getByText('Deterministic provider denied request (403).', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(screenshotDir, '02-channel-failure.png'), fullPage: true });
  await page.getByLabel('Channel recipient').selectOption('pet:beta');
  await page.getByLabel('Message', { exact: true }).fill('review');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await waitFor(async () => (await api(`/channels/interrupts?channelId=${firstId}`)).notifications.length === 1, 'review notice persisted');
  await page.locator('.channel-executions').getByText('review requested', { exact: true }).waitFor();
  const beforeReconnect = {
    executionIds: (await executions()).executions.map(item => item.executionId),
    outputIds: (await publicMessages()).map(item => item.messageId),
  };
  await page.reload();
  await page.locator('.connection-state.connected').waitFor();
  await page.getByRole('button', { name: 'channel', exact: true }).click();
  await page.locator('.channel-executions').getByText('Deterministic provider denied request (403).', { exact: true }).waitFor();
  assert.deepEqual((await executions()).executions.map(item => item.executionId), beforeReconnect.executionIds, 'page reload creates no dispatch');
  assert.deepEqual((await publicMessages()).map(item => item.messageId), beforeReconnect.outputIds);
  await page.getByText('Review notification history (1)', { exact: true }).waitFor();
  await page.getByText('Review notification history (1)', { exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Approve', exact: true }).count(), 0);
  await page.screenshot({ path: resolve(screenshotDir, '03-channel-review-history.png'), fullPage: true });
  host.kill('SIGTERM');
  await page.locator('.connection-state.reconnecting').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
  await page.locator('.channel-executions').getByText('status unknown', { exact: true }).waitFor();
  await new Promise(resolve => host.exitCode !== null ? resolve() : host.once('exit', resolve));
  await startHost(Number(new URL(ready.url).port));
  await page.locator('.connection-state.connected').waitFor();
  await page.locator('.channel-executions').getByText('status unknown', { exact: true }).waitFor();
  await page.locator('.channel-executions').getByText('Deterministic provider denied request (403).', { exact: true }).waitFor();
  assert.deepEqual((await executions()).executions.map(item => item.executionId), beforeReconnect.executionIds, 'Host restart and SSE reconnect create no dispatch');
  assert.deepEqual((await publicMessages()).map(item => item.messageId), beforeReconnect.outputIds);
  await page.getByLabel('Channel recipient').selectOption('pet:alpha');
  await page.getByLabel('Message', { exact: true }).fill('Continue after Host restart.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await waitFor(async () => (await publicMessages()).length === 4, 'execution after Host restart');
  assert.equal((await publicMessages())[3].source.sessionId, originalSession);
  await page.screenshot({ path: resolve(screenshotDir, '04-channel-host-restart.png'), fullPage: true });

  await create('Participant loop');
  const loopId = (await api('/channels')).channels.find(item => item.title === 'Participant loop').channelId;
  const loopContext = () => api(`/channels/context?channelId=${loopId}&limit=200`);
  const loopOutputs = async () => (await loopContext()).history.entries.filter(item => item.kind === 'message' && item.source);
  assert.equal(await page.locator('.channel-global-queues').count(), 0, 'no pre-send global status hint');
  await page.getByLabel('Channel recipient').selectOption('pet:alpha');
  await page.getByLabel('Message', { exact: true }).fill('handoff');
  await page.getByRole('button', { name: 'Insert @', exact: true }).click();
  assert.equal(await page.getByLabel('Channel recipient').inputValue(), '');
  assert.ok((await page.getByLabel('Message', { exact: true }).inputValue()).includes('participant:pet:alpha'));
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await waitFor(async () => (await loopOutputs()).length === 3, 'normal Alpha → Beta → Alpha loop');
  assert.deepEqual((await loopOutputs()).map(item => item.author.id), ['alpha', 'beta', 'alpha']);
  assert.deepEqual((await loopOutputs()).map(item => item.mentions[0].participantId), ['pet:beta', 'pet:alpha', 'human:studio-operator']);
  await page.locator('.channel-mentions').getByText('@Me', { exact: true }).waitFor();
  await page.locator('.channel-message-head').getByText('Me', { exact: true }).first().waitFor();
  const participantIds = (await api('/channels/participants')).participants.map(item => item.participantId);
  assert.deepEqual(new Set(participantIds), new Set(['human:studio-operator', 'pet:alpha', 'pet:beta']));
  await apiPost('/channels/messages', { channelId: secondId, body: 'queue-hold', mentions: [{ participantId: 'pet:alpha' }] });
  await waitFor(async () => (await api('/dispatch/queues')).queues.find(item => item.petId === 'alpha')?.activeDispatch?.scope?.id === secondId, 'global active work from another Channel');
  await page.getByLabel('Channel recipient').selectOption('pet:alpha');
  await page.getByLabel('Message', { exact: true }).fill('queue-next');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const alphaQueue = page.locator('.channel-queue').filter({ hasText: 'Alpha' });
  await alphaQueue.getByText('1 queued', { exact: true }).waitFor();
  await alphaQueue.getByText('Working · Separate investigation', { exact: true }).waitFor();
  await alphaQueue.locator('li').getByText('Participant loop', { exact: true }).waitFor();
  assert.ok(!/working|busy|queued/.test((await page.locator('.channel-composer').innerText()).toLowerCase()), 'composer has no pre-send busy hints');
  await page.screenshot({ path: resolve(screenshotDir, '05-channel-global-queue.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.getByRole('button', { name: 'Show execution details', exact: true }).click();
  await page.getByRole('dialog', { name: 'Channel execution details', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: resolve(screenshotDir, '06-channel-global-queue-mobile.png'), fullPage: true });
  await waitFor(async () => (await loopOutputs()).length === 4, 'queued input starts after global work finishes');
  assert.equal((await loopOutputs()).at(-1).source.sessionId, (await loopContext()).sessions.find(item => item.petId === 'alpha').sessionId);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', modelCalls: 0, coverage: ['unified identity-bearing participant protocol', 'normal Alpha-Beta-Alpha handoff', 'Pet addresses human without automatic response', 'actual global active work and queue across Channels', 'desktop and mobile queue UI', 'no pre-send status hint', 'create duplicate guard', 'note does not execute', 'same-session reply', 'cross-Channel isolation', 'failure timeline persists after reload and restart', 'original review guidance', 'disconnect disables submission', 'restart preserves session identity'], screenshots: screenshotDir }));
} finally {
  await browser?.close();
  for (const child of children) { if (child.exitCode === null) child.kill('SIGTERM'); }
  await Promise.all(children.map(child => child.exitCode !== null ? undefined : new Promise(resolve => child.once('exit', resolve))));
  await rm(hostRoot, { recursive: true, force: true });
}
