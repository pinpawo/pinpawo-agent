import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const app = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(app, '../..');
const screenshots = process.env.CHANNEL_SCREENSHOTS ?? '/tmp/channel-console-layout-screenshots';
const children = [];
const roots = [];
let browser;
const start = (args, cwd, env = {}) => {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env, LANGCHAIN_TRACING_V2: 'false', LANGSMITH_TRACING: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stderr.on('data', data => process.stderr.write(data));
  return child;
};
const until = async (check, label) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Timed out: ' + label);
};
const host = async seed => {
  const directory = await mkdtemp(resolve(tmpdir(), 'channel-layout-host-'));
  roots.push(directory);
  const child = start(['--import', 'tsx/esm', resolve(app, 'tests/support/channelHost.ts')], root,
    { CHANNEL_HOST_TEST_ROOT: directory, CHANNEL_HOST_TEST_DUPLICATE_NAMES: '1', CHANNEL_HOST_TEST_LAYOUT_SEED: seed ? '1' : '' });
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(Error('Host startup timed out')), 20000);
    child.once('exit', code => { clearTimeout(timer); reject(Error('Host exited ' + code)); });
    child.stdout.on('data', data => {
      buffer += data;
      for (const line of buffer.split('\n')) {
        if (!line.startsWith('{')) continue;
        const result = JSON.parse(line);
        if (result.ready) { clearTimeout(timer); resolve(result); }
      }
    });
  });
};
try {
  await mkdir(screenshots, { recursive: true });
  const first = await host(true);
  const second = await host(false);
  const vite = start([resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5199', '--strictPort'], app);
  await until(() => fetch('http://127.0.0.1:5199').then(r => r.ok).catch(() => false), 'Vite');
  assert.equal(vite.exitCode, null);
  const api = async (path, data) => {
    const response = await fetch(first.url + path, { method: data ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + first.token, 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
    assert.ok(response.ok, path + ': ' + response.status);
    return response.json();
  };
  const channel = (await api('/channels')).channels[0];
  const context = () => api('/channels/context?channelId=' + channel.channelId + '&limit=200');
  const execute = body => api('/channels/execute', { channelId: channel.channelId, petId: 'alpha', body });
  const note = body => api('/channels/messages', { channelId: channel.channelId, body });
  const longBody = '# Investigation notes\n\n' + Array.from({ length: 12 }, (_, i) => 'Evidence ' + (i + 1) + ': ' + 'A complete paragraph of public findings. '.repeat(5)).join('\n\n')
    + '\n\n~~~ts\nconst veryLongLine = "' + 'stored-evidence-'.repeat(90) + '";\nconsole.log(veryLongLine);\n~~~\n\n| Record | Observation |\n| --- | --- |\n| A | Verified against the stated scope |';
  await note(longBody);
  await execute('Summarize public evidence.');
  await until(async () => (await context()).history.entries.some(item => item.source?.petId === 'alpha'), 'public output');
  for (let i = 0; i < 18; i++) await note('Progress note ' + i + '. Evidence remains available for the next round.');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:5199');
  await page.getByLabel('Studio HTTP URL').fill(first.url);
  await page.getByLabel('Studio bearer token').fill(first.token);
  await page.getByRole('button', { name: 'CONNECT', exact: true }).click();
  await page.locator('.connection-state.connected').waitFor();
  await page.getByRole('button', { name: 'channel', exact: true }).click();
  await page.getByRole('heading', { name: channel.title, exact: true }).waitFor();
  const input = page.getByLabel('Message', { exact: true });
  await input.waitFor();
  assert.deepEqual(await page.getByLabel('Channel target Pet').locator('option').allTextContents(), ['Select a Pet…', 'Analyst (alpha)', 'Analyst (beta)']);
  assert.equal(await page.getByRole('button', { name: 'Reply to retired-pet', exact: true }).isDisabled(), true);
  assert.ok(await page.locator('.channel-message').filter({ hasText: 'Historical public delivery' }).getByText('Removed Pet', { exact: true }).count());
  const snapshot = await context();
  const output = snapshot.history.entries.find(item => item.source?.petId === 'alpha');
  const longMessage = snapshot.history.entries.find(item => item.body === longBody);
  const execution = (await api('/channels/executions?channelId=' + channel.channelId)).executions.find(item => item.petId === 'alpha');
  const message = id => page.locator('[data-message-id="' + id + '"]');
  const focusIs = id => until(() => page.evaluate(id => document.activeElement?.id === id, id), 'focus ' + id);
  const fits = async () => {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no page horizontal overflow');
    const box = await input.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height, 'composer remains in viewport');
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1), true, 'document does not scroll');
  };
  await fits();
  await until(() => page.locator('.channel-timeline-scroll').evaluate(node => node.scrollTop > 0), 'initial latest scroll');
  await page.locator('.channel-timeline-scroll').evaluate(node => { node.scrollTop = 0; });
  await page.getByRole('button', { name: 'Back to latest ↓', exact: true }).waitFor();
  const scrollBefore = await page.locator('.channel-timeline-scroll').evaluate(node => node.scrollTop);
  await note('New evidence arrived while reading older messages.');
  await page.getByText('New evidence arrived while reading older messages.', { exact: true }).waitFor();
  assert.equal(await page.locator('.channel-timeline-scroll').evaluate(node => node.scrollTop), scrollBefore, 'SSE does not move an older reading position');
  await message(longMessage.messageId).scrollIntoViewIfNeeded();
  assert.equal(await message(longMessage.messageId).locator('pre').evaluate(node => node.scrollWidth > node.clientWidth), true, 'wide code scrolls within its own block');
  await message(longMessage.messageId).locator('pre').scrollIntoViewIfNeeded();
  await fits();
  await page.screenshot({ path: resolve(screenshots, '01-desktop-long-code.png'), fullPage: true });
  const readingPosition = await page.locator('.channel-timeline-scroll').evaluate(node => node.scrollTop);
  await page.getByRole('button', { name: 'kanban', exact: true }).click();
  await page.getByRole('button', { name: 'channel', exact: true }).click();
  assert.equal(await page.locator('.channel-timeline-scroll').evaluate(node => node.scrollTop), readingPosition, 'global navigation preserves an older reading position');
  await message(output.messageId).getByRole('button', { name: 'View execution', exact: true }).click();
  await focusIs('execution-' + execution.executionId);
  await page.locator('[id="execution-' + execution.executionId + '"]').getByRole('button', { name: 'Locate request', exact: true }).click();
  await focusIs('message-' + execution.messageId);
  await page.locator('[id="execution-' + execution.executionId + '"]').getByRole('button', { name: 'Locate output', exact: true }).click();
  await focusIs('message-' + output.messageId);
  await message(output.messageId).getByRole('button', { name: 'Reply to Analyst', exact: true }).click();
  await input.fill('Keep this draft when cancelling the reply.');
  assert.equal(await page.getByLabel('Channel target Pet').isDisabled(), true);
  await page.getByRole('button', { name: 'Cancel reply', exact: true }).click();
  assert.equal(await input.inputValue(), 'Keep this draft when cancelling the reply.');
  assert.equal(await page.getByLabel('Channel target Pet').isDisabled(), false);
  assert.equal(await input.evaluate(node => document.activeElement === node), true);
  await message(output.messageId).getByRole('button', { name: 'Reply to Analyst', exact: true }).click();
  await input.fill('Continue from the public reply.');
  await page.getByRole('button', { name: 'Send reply', exact: true }).click();
  await until(async () => (await context()).history.entries.some(item => item.replyTo === output.messageId), 'persisted reply');
  const reply = (await context()).history.entries.find(item => item.replyTo === output.messageId);
  await message(reply.messageId).locator('.channel-quote').click();
  await focusIs('message-' + output.messageId);
  assert.equal(await message(reply.messageId).locator('.channel-quote').count(), 1);
  await message(output.messageId).locator('summary').click();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await message(output.messageId).getByRole('button', { name: 'Copy message ID', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), output.messageId);
  await message(output.messageId).locator('summary').click();
  await page.getByRole('button', { name: '+ New Channel', exact: true }).click();
  assert.equal(await page.getByLabel('Channel title').evaluate(node => document.activeElement === node), true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.getByRole('dialog', { name: 'Create Channel' }).evaluate(node => node.contains(document.activeElement)), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button', { name: '+ New Channel', exact: true }).evaluate(node => document.activeElement === node), true);
  await page.getByRole('button', { name: 'Hide execution details', exact: true }).click();
  assert.equal(await page.locator('#channel-activity-panel').isVisible(), false);
  await fits();
  for (const width of [900, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await fits();
    await page.getByRole('button', { name: 'Show execution details', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Channel execution details', exact: true });
    await drawer.waitFor();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await drawer.evaluate(node => node.contains(document.activeElement)), true, 'activity focus remains in drawer');
    await page.keyboard.press('Tab');
    assert.equal(await drawer.evaluate(node => node.contains(document.activeElement)), true);
    await page.screenshot({ path: resolve(screenshots, '02-activity-' + width + '.png'), fullPage: true });
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button', { name: 'Show execution details', exact: true }).evaluate(node => document.activeElement === node), true);
    if (width <= 700) {
      await page.getByRole('button', { name: 'Show Channel navigation', exact: true }).click();
      const nav = page.getByRole('dialog', { name: 'Channel navigation', exact: true });
      await nav.waitFor();
      await page.keyboard.press('Shift+Tab');
      assert.equal(await nav.evaluate(node => node.contains(document.activeElement)), true);
      await page.getByRole('button', { name: 'Close panel', exact: true }).click({ position: { x: width - 10, y: 450 } });
      assert.equal(await page.getByRole('button', { name: 'Show Channel navigation', exact: true }).evaluate(node => document.activeElement === node), true);
    }
    await message(output.messageId).getByRole('button', { name: 'View execution', exact: true }).click();
    await focusIs('execution-' + execution.executionId);
    await page.locator('[id="execution-' + execution.executionId + '"]').getByRole('button', { name: 'Locate output', exact: true }).click();
    await focusIs('message-' + output.messageId);
    assert.equal(await page.getByRole('dialog', { name: 'Channel execution details', exact: true }).count(), 0);
    await page.screenshot({ path: resolve(screenshots, '03-conversation-' + width + '.png'), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  let rejectedWrites = 0;
  await page.route(first.url + '/channels/execute', route => {
    rejectedWrites++;
    return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Unauthorized fixture request"}' });
  });
  await page.getByLabel('Channel target Pet').selectOption('alpha');
  await input.fill('Keep rejected draft.');
  await page.getByRole('button', { name: 'Send to Pet', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Unauthorized fixture request' }).waitFor();
  assert.equal(await input.inputValue(), 'Keep rejected draft.');
  assert.equal(rejectedWrites, 1, 'rejected submission is not retried');
  await page.unroute(first.url + '/channels/execute');
  const other = await api('/channels', { title: 'Separate layout', goal: 'A separate goal.', scope: 'A separate scope.' });
  await page.locator('.channel-list button').filter({ hasText: other.title }).waitFor();
  await message(output.messageId).getByRole('button', { name: 'Reply to Analyst', exact: true }).click();
  await input.fill('Channel A draft must not cross Channels.');
  await page.locator('.channel-list button').filter({ hasText: other.title }).click();
  await input.waitFor();
  assert.equal(await input.inputValue(), '');
  assert.equal(await page.getByLabel('Channel target Pet').inputValue(), '');
  assert.equal(await page.locator('.channel-message').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Cancel reply', exact: true }).count(), 0);
  await page.locator('.channel-list button').filter({ hasText: channel.title }).click();
  await message(output.messageId).waitFor();
  await message(output.messageId).getByRole('button', { name: 'Reply to Analyst', exact: true }).click();
  await input.fill('Host A draft must not cross hosts.');
  await page.getByRole('button', { name: 'CONNECTION', exact: true }).click();
  await page.getByLabel('Studio HTTP URL').fill(second.url);
  await page.getByRole('button', { name: 'CONNECT', exact: true }).click();
  await page.getByText('No Channels yet.', { exact: true }).waitFor();
  assert.equal(await page.locator('.channel-message').count(), 0, 'Host switch clears previous history');
  assert.equal(await page.getByRole('button', { name: 'Cancel reply', exact: true }).count(), 0);
  await page.getByRole('button', { name: '+ New Channel', exact: true }).click();
  await page.getByLabel('Channel title').fill('Host B fresh');
  await page.getByLabel('Channel goal').fill('Independent goal.');
  await page.getByLabel('Channel scope').fill('Independent scope.');
  await page.getByRole('button', { name: 'Create Channel', exact: true }).click();
  await input.waitFor();
  assert.equal(await input.inputValue(), '');
  assert.equal(await page.getByLabel('Channel target Pet').inputValue(), '');
  await page.screenshot({ path: resolve(screenshots, '04-host-switch-empty.png'), fullPage: true });
  await page.route(second.url + '/channels**', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"fixture plugin unavailable"}' }));
  await page.reload();
  await page.locator('.connection-state.connected').waitFor();
  await page.getByRole('button', { name: 'channel', exact: true }).click();
  await page.getByText('Channel Plugin unavailable', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '+ New Channel', exact: true }).isDisabled(), true);
  await page.screenshot({ path: resolve(screenshots, '05-plugin-unavailable.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', modelCalls: 0, screenshots,
    coverage: ['long Markdown and internal code scrolling', 'fixed composer and independent timeline', 'SSE preserves older reading position',
      'duplicate Pet names and removed Pet', 'real request/output association', 'reply cancel retains draft and focus', 'one-level quote location',
      'copy stored message ID', 'global navigation retains reading position', 'create modal keyboard focus', 'collapsible activity', '900/390/320px drawers and focus/Escape/backdrop',
      'drawer execution/output focus', '401 retains draft without retry', 'Channel and Host switch clear history/reply/draft/target', '404 plugin unavailable'] }));
} finally {
  await browser?.close();
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.all(children.map(child => child.exitCode !== null ? undefined : new Promise(resolve => child.once('exit', resolve))));
  await Promise.all(roots.map(directory => rm(directory, { recursive: true, force: true })));
}
