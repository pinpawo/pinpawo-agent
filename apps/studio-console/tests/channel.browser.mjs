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
      for (const line of buffer.split('\n').slice(0, -1)) {
        if (!line.startsWith('{"ready"')) continue;
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
  const sessions = async channelId => (await api(`/channels/sessions?channelId=${channelId}`)).sessions;
  browser = await chromium.launch({ headless: true, ...(process.env.CHANNEL_BROWSER_EXECUTABLE ? { executablePath: process.env.CHANNEL_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:5199');
  await page.getByLabel('Studio HTTP URL').fill(ready.url);
  await page.getByLabel('Studio bearer token').fill(ready.token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('.connection-state.connected').waitFor();
  await page.getByRole('button', { name: 'Channel', exact: true }).click();
  const create = async (title, petNames) => {
    await page.getByRole('button', { name: '+ New Channel', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create Channel' });
    await dialog.getByLabel('Channel title').fill(title);
    await dialog.getByLabel('Channel description').fill('Auditable public messages between members.');
    for (const name of petNames) await dialog.getByRole('checkbox', { name, exact: true }).check();
    await dialog.evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    await page.getByRole('heading', { name: title, exact: true }).waitFor();
  };
  await page.getByRole('button', { name: '+ New Channel', exact: true }).click();
  assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 0, 'no Pet joins without an explicit choice');
  assert.equal(await page.getByLabel('Channel goal').count(), 0, 'no goal or scope is asked for');
  await page.keyboard.press('Escape');
  await create('Customer records', ['Alpha', 'Beta']);
  let listed = await api('/channels');
  assert.equal(listed.channels.length, 1, 'duplicate form submission creates one Channel');
  const firstId = listed.channels[0].channelId;
  assert.equal(listed.channels[0].description, 'Auditable public messages between members.');
  const context = () => api(`/channels/context?channelId=${firstId}&limit=200`);
  const publicMessages = async () => (await context()).messages.filter(item => item.author.kind === 'pet');
  assert.deepEqual((await context()).members.map(item => item.participantId), ['human:local', 'pet:alpha', 'pet:beta']);
  const memberPanel = page.getByRole('region', { name: 'Channel members' });
  // The composer is a rich-text editor: @ opens the member list and a picked member becomes an inline mention.
  const input = page.getByLabel('Message', { exact: true });
  const mentionList = page.getByRole('listbox', { name: 'Members to mention' });
  const composerMentions = () => input.locator('[data-type="mention"]').evaluateAll(nodes => nodes.map(node => node.dataset.id));
  const clearComposer = async () => { await input.click(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace'); };
  const openMentions = async () => { await input.click(); await page.keyboard.press('End'); await page.keyboard.type('@'); await mentionList.waitFor(); };
  const mentionable = async () => { await openMentions(); return mentionList.locator('code').allTextContents(); };
  const mention = async participantId => {
    if (!(await mentionList.isVisible())) await openMentions();
    await mentionList.getByRole('option').filter({ hasText: participantId }).click();
    await mentionList.waitFor({ state: 'detached' });
  };
  await memberPanel.getByText('pet:beta', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
  await page.getByLabel('Message', { exact: true }).fill('A note mentioning @beta without addressing anyone.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('A note mentioning @beta without addressing anyone.', { exact: true }).waitFor();
  assert.deepEqual(await sessions(firstId), [], 'a note wakes no Pet');
  await mention('pet:alpha');
  await page.keyboard.type('Investigate the current state.');
  await page.locator('.channel-composer').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
  await waitFor(async () => (await publicMessages()).length === 1, 'first Pet message');
  await page.getByText('Full handoff evidence:', { exact: false }).first().waitFor();
  await page.locator('.channel-inline-state').filter({ hasText: 'Alpha · dispatch accepted' }).first().waitFor();
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal((await publicMessages()).length, 1, 'duplicate form submission starts one dispatch');
  const originalSession = (await sessions(firstId)).find(item => item.petId === 'alpha').sessionId;
  assert.equal((await publicMessages())[0].externalRef !== undefined, true, 'a Pet message keeps its session message id');
  await page.getByRole('button', { name: 'Reply to Alpha', exact: true }).first().click();
  assert.deepEqual(await composerMentions(), ['pet:alpha'], 'Reply preselects the original author without manual selection');
  await page.keyboard.type('Continue with the same evidence.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await waitFor(async () => (await publicMessages()).length === 2, 'reply completed');
  assert.ok((await publicMessages())[1].body.includes(`Session: ${originalSession}`));
  assert.ok((await publicMessages())[1].body.includes('Continue with the same evidence.'));
  assert.ok((await publicMessages())[1].body.includes(`Referenced message: ${(await publicMessages())[0].messageId}.`));
  assert.ok((await publicMessages())[1].body.includes('Input source: human:local.'));
  await mention('pet:beta');
  await page.keyboard.type('Read prior public evidence and review the delivery.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await waitFor(async () => (await publicMessages()).length === 3, 'second Pet completed');
  assert.ok((await publicMessages())[2].body.includes('Prior public deliveries read: 2.'));
  assert.notEqual((await sessions(firstId)).find(item => item.petId === 'beta').sessionId, originalSession);
  await page.screenshot({ path: resolve(screenshotDir, '01-channel-timeline.png'), fullPage: true });
  // Override and clear the default through the real UI and inspect what the Host did.
  await page.getByRole('button', { name: 'Reply to Alpha', exact: true }).first().click();
  assert.deepEqual(await composerMentions(), ['pet:alpha']);
  await clearComposer();
  await mention('pet:beta');
  await page.keyboard.type('Changed recipient, same quoted Alpha message.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await waitFor(async () => (await publicMessages()).length === 4, 'changed reply target runs Beta');
  assert.equal((await publicMessages()).at(-1).author.id, 'beta');
  await page.getByRole('button', { name: 'Reply to Alpha', exact: true }).first().click();
  await clearComposer();
  assert.deepEqual(await composerMentions(), []);
  await page.locator('.channel-composer-hint').getByText('Without an @, no Pet is woken unless Channel routing picks one.', { exact: false }).waitFor();
  await page.keyboard.type('Saved reply with recipient cleared.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('Saved reply with recipient cleared.', { exact: true }).waitFor();
  const saved = (await context()).messages.find(item => item.body === 'Saved reply with recipient cleared.');
  assert.ok(saved.replyTo); assert.deepEqual(saved.mentions, []);
  await page.locator(`[data-message-id="${saved.messageId}"]`).getByRole('button', { name: 'Reply to Me', exact: true }).click();
  assert.deepEqual(await composerMentions(), ['human:local']);
  await page.keyboard.type('Human author reply stays public.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('Human author reply stays public.').waitFor();
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal((await publicMessages()).length, 4, 'cleared and human recipients wake no Pet');

  await create('Separate investigation', ['Alpha']);
  assert.deepEqual(await composerMentions(), [], 'new Channel requires a fresh explicit recipient');
  assert.deepEqual(await mentionable(), ['human:local', 'pet:alpha'], 'only members can be addressed');
  await page.screenshot({ path: resolve(screenshotDir, '06-channel-mention-autocomplete.png') });
  listed = await api('/channels');
  assert.equal(listed.channels.length, 2);
  const secondId = listed.channels.find(item => item.title === 'Separate investigation').channelId;
  await mention('pet:alpha');
  await page.keyboard.type('Check the isolated Channel.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const other = await waitFor(async () => {
    const value = await api(`/channels/context?channelId=${secondId}`);
    return value.messages.some(item => item.author.kind === 'pet') && value;
  }, 'other Channel output');
  assert.notEqual((await sessions(secondId))[0].sessionId, originalSession);
  assert.ok(other.messages.find(item => item.author.kind === 'pet').body.includes('Prior public deliveries read: 0.'));
  await page.locator('.channel-list button').filter({ hasText: 'Customer records' }).click();
  await page.getByRole('heading', { name: 'Customer records', exact: true }).waitFor();
  const beforeReconnect = (await publicMessages()).map(item => item.messageId);
  await page.reload();
  await page.locator('.connection-state.connected').waitFor();
  await page.getByRole('button', { name: 'Channel', exact: true }).click();
  await page.getByText('Human author reply stays public.').waitFor();
  assert.deepEqual((await publicMessages()).map(item => item.messageId), beforeReconnect, 'page reload creates no dispatch');
  await page.locator('.channel-list button').filter({ hasText: 'Customer records' }).click();
  assert.equal(await page.getByText('Human author reply stays public.').isVisible(), true, 'clicking the open Channel keeps its messages');
  assert.equal(await page.getByText('Start a Channel').count(), 0);
  host.kill('SIGTERM');
  await page.locator('.connection-state.reconnecting').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
  await new Promise(resolve => host.exitCode !== null ? resolve() : host.once('exit', resolve));
  await startHost(Number(new URL(ready.url).port));
  await page.locator('.connection-state.connected').waitFor();
  assert.deepEqual((await publicMessages()).map(item => item.messageId), beforeReconnect, 'Host restart and SSE reconnect create no dispatch');
  await mention('pet:alpha');
  await page.keyboard.type('Continue after Host restart.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await waitFor(async () => (await publicMessages()).length === 5, 'Pet message after Host restart');
  assert.ok((await publicMessages())[4].body.includes(`Session: ${originalSession}`), 'restart keeps the Channel session');
  await page.screenshot({ path: resolve(screenshotDir, '02-channel-host-restart.png'), fullPage: true });

  // Members: removing a Pet stops it being addressed; adding it back restores the same session.
  await memberPanel.getByRole('button', { name: 'Remove Beta', exact: true }).click();
  await waitFor(async () => !(await api(`/channels/members?channelId=${firstId}`)).members.some(item => item.participantId === 'pet:beta'), 'Beta left');
  await memberPanel.getByText('pet:beta', { exact: true }).waitFor({ state: 'detached' });
  assert.ok(!(await mentionable()).includes('pet:beta'), 'Beta is no longer addressable');
  await page.keyboard.press('Escape');
  await clearComposer();
  assert.equal(await memberPanel.getByRole('button', { name: 'Remove Me', exact: true }).count(), 0, 'the Console cannot remove its own member');
  await page.locator('[data-message-id]').filter({ hasText: 'Public delivery from beta.' }).first().getByText('Beta', { exact: true }).first().waitFor();
  await memberPanel.getByLabel('Pet to add').selectOption('beta');
  await memberPanel.getByRole('button', { name: 'Add Pet', exact: true }).click();
  await memberPanel.getByText('pet:beta', { exact: true }).waitFor();
  assert.equal(await memberPanel.getByLabel('Pet to add').isDisabled(), true, 'every Pet is a member again');
  // A human member is a Studio client; it must be registered before it can join.
  await apiPost('/clients', { clientId: 'reviewer-1', label: 'Reviewer One' });
  await memberPanel.getByLabel('Human member ID').fill('reviewer-1');
  await memberPanel.getByRole('button', { name: 'Add human', exact: true }).click();
  await memberPanel.getByText('human:reviewer-1', { exact: true }).waitFor();
  assert.ok((await mentionable()).includes('human:reviewer-1'));
  await mention('human:reviewer-1');
  await page.keyboard.type('A human member is addressed without waking a Pet.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.locator('.channel-inline-state').filter({ hasText: 'Reviewer One · delivered' }).waitFor();
  await memberPanel.getByRole('button', { name: 'Remove Reviewer One', exact: true }).click();
  await waitFor(async () => !(await api(`/channels/members?channelId=${firstId}`)).members.some(item => item.id === 'reviewer-1'), 'human left');
  // A Pet's session opens from the member list.
  await memberPanel.locator('.channel-member').filter({ hasText: 'pet:alpha' }).getByRole('button', { name: 'View session', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: /session/ });
  await viewer.getByText(originalSession, { exact: true }).first().waitFor();
  await viewer.getByRole('button', { name: 'Close session view' }).click();
  await viewer.waitFor({ state: 'detached' });

  await create('Participant loop', ['Alpha', 'Beta']);
  const loopId = (await api('/channels')).channels.find(item => item.title === 'Participant loop').channelId;
  const loopContext = () => api(`/channels/context?channelId=${loopId}&limit=200`);
  const loopOutputs = async () => (await loopContext()).messages.filter(item => item.author.kind === 'pet');
  assert.equal(await page.locator('.channel-global-queues').count(), 0, 'no pre-send global status hint');
  // Keyboard only: filter the @ list by typing, Enter picks the highlighted member, Enter again sends.
  await input.click();
  await page.keyboard.type('@Alp');
  assert.deepEqual(await mentionList.locator('code').allTextContents(), ['pet:alpha']);
  await page.keyboard.press('Enter');
  await page.keyboard.type('handoff');
  assert.deepEqual(await composerMentions(), ['pet:alpha']);
  await page.keyboard.press('Enter');
  await waitFor(async () => (await loopOutputs()).length === 3, 'normal Alpha → Beta → Alpha loop');
  assert.deepEqual((await loopOutputs()).map(item => item.author.id), ['alpha', 'beta', 'alpha']);
  assert.deepEqual((await loopOutputs()).map(item => item.mentions[0].participantId), ['pet:beta', 'pet:alpha', 'human:local']);
  await page.locator('.channel-message-body .channel-mention').getByText('@Me', { exact: true }).waitFor();
  assert.equal(await page.locator('.channel-mentions').count(), 0, 'an inline @ is not repeated above the message');
  await page.locator('.channel-message-head').getByText('Me', { exact: true }).first().waitFor();
  const memberIds = (await api(`/channels/members?channelId=${loopId}`)).members.map(item => item.participantId);
  assert.deepEqual(new Set(memberIds), new Set(['human:local', 'pet:alpha', 'pet:beta']));
  await apiPost('/channels/messages', { channelId: secondId, body: 'queue-hold', mentions: [{ participantId: 'pet:alpha' }] });
  await waitFor(async () => (await api('/dispatch/queues')).queues.find(item => item.petId === 'alpha')?.activeDispatch?.scope?.id === secondId, 'global active work from another Channel');
  await mention('pet:alpha');
  await page.keyboard.type('queue-next');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const alphaQueue = page.locator('.channel-queue').filter({ hasText: 'Alpha' });
  await alphaQueue.getByText('1 queued', { exact: true }).waitFor();
  await alphaQueue.getByText('Working · Separate investigation', { exact: true }).waitFor();
  await alphaQueue.locator('li').getByText('Participant loop', { exact: true }).waitFor();
  assert.equal(await page.locator('.channel-working').count(), 0, 'a Pet at work in another Channel, queued here, is not typing here');
  assert.ok(!/working|busy|queued/.test((await page.locator('.channel-composer').innerText()).toLowerCase()), 'composer has no pre-send busy hints');
  await page.screenshot({ path: resolve(screenshotDir, '03-channel-global-queue.png'), fullPage: true });
  await page.getByRole('button', { name: 'Scheduler', exact: true }).hover();
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(screenshotDir, '07-page-rail-tooltip.png'), clip: { x: 0, y: 0, width: 420, height: 320 } });
  await page.mouse.move(700, 500);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.getByRole('button', { name: 'Show Channel details', exact: true }).click();
  await page.getByRole('dialog', { name: 'Channel details', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: resolve(screenshotDir, '04-channel-members-mobile.png'), fullPage: true });
  await waitFor(async () => (await loopOutputs()).length === 4, 'queued input starts after global work finishes');
  // A second person connects with their own client key: only their Channels, polled, no local-token views.
  const { key: bobKey } = await apiPost('/clients', { clientId: 'bob', label: 'Bob' });
  await apiPost('/channels/members', { channelId: loopId, kind: 'human', id: 'bob' });
  const bob = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  bob.on('pageerror', error => errors.push(error.message));
  await bob.goto('http://127.0.0.1:5199');
  await bob.getByLabel('Studio HTTP URL').fill(ready.url);
  await bob.getByLabel('Studio bearer token').fill(bobKey);
  await bob.getByRole('button', { name: 'Connect', exact: true }).click();
  await bob.locator('.connection-state.connected').getByText('bob', { exact: false }).waitFor();
  assert.deepEqual(await bob.getByRole('navigation', { name: 'Studio pages' }).getByRole('button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['Channel']);
  await bob.getByRole('heading', { name: 'Participant loop', exact: true }).waitFor();
  assert.equal(await bob.getByRole('button', { name: 'Separate investigation', exact: false }).count(), 0, 'a client lists only its own Channels');
  assert.equal(await bob.getByRole('button', { name: 'View session', exact: true }).count(), 0, 'Pet sessions stay with the local token');
  assert.equal(await bob.locator('.channel-queue').count(), 0, 'dispatch queues stay with the local token');
  await bob.getByLabel('Message', { exact: true }).fill('Bob checking in.');
  await bob.getByRole('button', { name: 'Send message', exact: true }).click();
  await waitFor(async () => (await loopContext()).messages.some(item => item.body === 'Bob checking in.' && item.author.id === 'bob'), 'Bob posts as himself');
  await apiPost('/channels/messages', { channelId: loopId, body: 'Local reply for Bob.' });
  await bob.getByText('Local reply for Bob.', { exact: true }).waitFor({ timeout: 10000 });
  await bob.screenshot({ path: resolve(screenshotDir, '05-channel-client.png'), fullPage: true });
  // A long Channel opens on its newest page, reads back on request and takes new messages without reloading.
  const { channel: long } = await apiPost('/channels', { title: 'Long history', pets: [] });
  for (let index = 0; index < 105; index += 1) await apiPost('/channels/messages', { channelId: long.channelId, body: `History ${index}` });
  await page.setViewportSize({ width: 1440, height: 1000 });
  // A Pet running a turn in the Channel shows as typing after the newest message: the local token by event, a client by its poll.
  await apiPost('/channels/messages', { channelId: loopId, body: 'queue-hold', mentions: [{ participantId: 'pet:alpha' }] });
  await page.locator('.channel-working').getByText('Alpha is typing…', { exact: true }).waitFor();
  await bob.locator('.channel-working').getByText('Alpha is typing…', { exact: true }).waitFor({ timeout: 10000 });
  await page.screenshot({ path: resolve(screenshotDir, '08-channel-typing.png'), fullPage: true });
  await bob.screenshot({ path: resolve(screenshotDir, '09-channel-typing-client.png'), fullPage: true });
  await waitFor(async () => (await loopOutputs()).length === 5, 'the typing Pet replies');
  await page.locator('.channel-working').waitFor({ state: 'detached', timeout: 5000 });
  await bob.locator('.channel-working').waitFor({ state: 'detached', timeout: 10000 });
  // A renamed Pet shows its new name without reconnecting: the local token through pet.* events, a client through its poll.
  await apiPost('/pets/rename', { petId: 'beta', name: 'Beta Renamed' });
  await page.getByRole('button', { name: '+ New Channel', exact: true }).click();
  await page.getByRole('dialog', { name: 'Create Channel' }).getByRole('checkbox', { name: 'Beta Renamed', exact: true }).waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
  await bob.getByText('Beta Renamed', { exact: false }).first().waitFor({ timeout: 10000 });
  await apiPost('/pets/rename', { petId: 'beta', name: 'Beta' });
  await page.getByRole('navigation', { name: 'Channel navigation' }).getByRole('button', { name: /Long history/ }).click();
  await page.getByText('History 104', { exact: true }).waitFor();
  const shown = () => page.locator('.channel-message').count();
  assert.equal(await shown(), 100, 'only the newest page is read');
  const contextReads = [];
  page.on('request', request => { if (request.url().includes('/channels/context')) contextReads.push(new URL(request.url()).search); });
  await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
  await page.getByText('History 0', { exact: true }).waitFor();
  assert.equal(await shown(), 105);
  assert.equal(await page.getByRole('button', { name: 'Load earlier messages', exact: true }).count(), 0);
  await apiPost('/channels/messages', { channelId: long.channelId, body: 'History 105' });
  await page.getByText('History 105', { exact: true }).waitFor();
  assert.equal(await shown(), 106);
  assert.ok(contextReads.length >= 2 && contextReads.slice(1).every(search => /[?&]after=\d+/.test(search) && !search.includes('after=0')),
    `a new message reads only what follows the newest held: ${contextReads.join(' ')}`);
  // Reads overlap: hold one kind of Channel read until released.
  const hold = async param => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const matches = target => target.pathname === '/channels/context' && target.searchParams.has(param);
    const held = [];
    const handler = async route => { held.push(route.request().url()); await gate; await route.continue(); };
    await page.route(matches, handler);
    return { held, release: async () => { release(); await waitFor(async () => true, 'release'); await page.unroute(matches, handler); } };
  };
  const loadEarlierButton = page.getByRole('button', { name: 'Load earlier messages', exact: true });
  const refreshHistory = async () => {
    const button = page.getByRole('button', { name: '↻ Refresh persisted history', exact: true });
    if (!(await button.isVisible())) await page.getByRole('button', { name: 'Show Channel details', exact: true }).click();
    await button.click();
  };
  // A newer read that lands after an older page keeps the older edge it does not own.
  await refreshHistory();
  await waitFor(async () => (await shown()) === 100, 'newest page after refresh');
  const laterRead = await hold('after');
  await apiPost('/channels/messages', { channelId: long.channelId, body: 'History 106' });
  await waitFor(async () => laterRead.held.length > 0, 'incremental read in flight');
  await loadEarlierButton.click();
  await page.getByText('History 0', { exact: true }).waitFor();
  await laterRead.release();
  await page.getByText('History 106', { exact: true }).waitFor();
  assert.equal(await shown(), 107);
  assert.equal(await loadEarlierButton.count(), 0, 'a late newer read does not bring back an older edge already passed');
  // An older page read for a window that was refreshed meanwhile is dropped rather than leaving a gap.
  await refreshHistory();
  await waitFor(async () => (await shown()) === 100, 'newest page after second refresh');
  const earlierRead = await hold('before');
  await loadEarlierButton.click();
  await waitFor(async () => earlierRead.held.length > 0, 'older page in flight');
  for (const index of [107, 108, 109]) await apiPost('/channels/messages', { channelId: long.channelId, body: `History ${index}` });
  await page.getByText('History 109', { exact: true }).waitFor();
  await refreshHistory();
  await waitFor(async () => (await page.locator('.channel-message').first().innerText()).includes('History 10'), 'third window opens at History 10');
  await earlierRead.release();
  await page.waitForTimeout(300);
  assert.equal(await shown(), 100, 'the stale older page is not merged');
  await loadEarlierButton.click();
  await page.getByText('History 0', { exact: true }).waitFor();
  assert.equal(await shown(), 110, 'nothing is missing between the pages');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', modelCalls: 0, coverage: ['explicit Pet selection on create', 'members-only addressing', 'normal Alpha-Beta-Alpha handoff', 'Pet addresses human without automatic response', 'actual global active work and queue across Channels', 'typing Pet for local token and client', 'desktop and mobile member panel', 'no pre-send status hint', 'create duplicate guard', 'note does not wake a Pet', 'default Reply without manual recipient selection', 'inline @ autocomplete with mouse and keyboard', 'changed and cleared Reply recipients', 'human Reply without Pet dispatch', 'same-session reply', 'cross-Channel isolation', 'reload and Host restart create no dispatch', 'disconnect disables submission', 'restart preserves session identity', 'remove and re-add Pet and human members', 'session view from member list', 'client key sees only its Channels and polls', 'renamed Pet refreshes by event and by poll', 'newest page first, load earlier, incremental new messages', 'overlapping Channel reads keep a gapless window'], screenshots: screenshotDir }));
} finally {
  await browser?.close();
  for (const child of children) { if (child.exitCode === null) child.kill('SIGTERM'); }
  await Promise.all(children.map(child => child.exitCode !== null ? undefined : new Promise(resolve => child.once('exit', resolve))));
  await rm(hostRoot, { recursive: true, force: true });
}
