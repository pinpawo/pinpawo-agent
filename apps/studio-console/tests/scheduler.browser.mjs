import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Isolated Studio fixture: Pet A is only in Channel X, Pet B only in Channel Y, Channel Z has no Pet.
const app = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(app, '../..');
const date = '2026-10-28T00:00:00Z';
const channel = (channelId, title) => ({ channelId, title, createdBy: { kind: 'human', id: 'local' }, createdAt: date, updatedAt: date });
const member = (kind, id) => ({ participantId: `${kind}:${id}`, kind, id, label: id, joinedAt: date });
const members = {
  x: [member('human', 'local'), member('pet', 'a')],
  y: [member('human', 'local'), member('pet', 'b')],
  z: [member('human', 'local')],
};
const created = [];
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', '*');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  if (url.pathname === '/events') { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': connected\n\n'); return; }
  const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
  if (request.method === 'POST' && url.pathname === '/scheduler') {
    let body = ''; for await (const chunk of request) body += chunk;
    created.push(JSON.parse(body));
    send(201, { schedule: {} }); return;
  }
  if (url.pathname === '/channels/members') { send(200, { members: members[url.searchParams.get('channelId')] ?? [] }); return; }
  const values = {
    '/me': { clientId: 'local', scope: 'studio' },
    '/pets': { pets: [{ petId: 'a', name: 'A', definitionId: 'd' }, { petId: 'b', name: 'B', definitionId: 'd' }] },
    '/scheduler': { schedules: [] }, '/notices': { notices: [] }, '/triggers': { triggers: [], deliveries: [] },
    '/knowledge': { documents: [] }, '/scheduler/events': { events: [] }, '/triggers/events': { events: [] },
    '/channels': { channels: [channel('x', 'X'), channel('y', 'Y'), channel('z', 'Z')], nextAfter: 3, hasMore: false },
    '/channels/context': { channel: channel('x', 'X'), members: members.x, messages: [], viewerParticipantId: 'human:local', nextAfter: 0, nextBefore: 0, hasMore: false, hasEarlier: false },
    '/channels/sessions': { sessions: [] }, '/dispatch/queues': { queues: [] },
  };
  send(url.pathname in values ? 200 : 404, values[url.pathname] ?? { error: 'fixture route not found' });
});
let browser; let vite;
const until = async (check, label) => {
  for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise((done) => setTimeout(done, 100)); }
  throw Error(`Timed out: ${label}`);
};
try {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  vite = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5229', '--strictPort'], { cwd: app, stdio: 'pipe' });
  vite.stderr.on('data', (data) => process.stderr.write(data));
  await until(() => fetch('http://127.0.0.1:5229').then((r) => r.ok).catch(() => false), 'frontend');
  browser = await chromium.launch({ headless: true, ...(process.env.SCHEDULER_BROWSER_EXECUTABLE ? { executablePath: process.env.SCHEDULER_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:5229');
  await page.getByLabel('Studio HTTP URL').fill(`http://127.0.0.1:${server.address().port}`);
  await page.getByLabel('Studio bearer token').fill('synthetic-only-token');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('.connection-state.connected').waitFor();
  await page.getByRole('navigation', { name: 'Studio pages' }).getByRole('button', { name: 'Scheduler' }).click();
  const channelSelect = page.getByLabel('Schedule Channel');
  const petSelect = page.getByLabel('Schedule Pet');
  const petOptions = () => petSelect.locator('option').evaluateAll((nodes) => nodes.map((node) => node.value));
  const submit = page.getByRole('button', { name: 'Schedule', exact: true });

  // Channel X offers only A; switching to Y drops A and offers only B.
  await until(async () => (await channelSelect.inputValue()) === 'x' && (await petOptions()).join() === 'a', 'X offers A');
  await channelSelect.selectOption('y');
  await until(async () => (await petOptions()).join() === 'b', 'Y offers B');
  assert.equal(await petSelect.inputValue(), 'b', 'the Pet chosen for X does not carry over to Y');
  // A + Y can never be submitted.
  assert.equal(await petSelect.locator('option[value="a"]').count(), 0);
  await page.getByPlaceholder('Scheduled goal…').fill('Nightly report');
  await page.locator('input[type="datetime-local"]').fill('2030-01-01T09:00');
  await submit.click();
  await until(() => created.length === 1, 'schedule created');
  assert.deepEqual([created[0].petId, created[0].channelId], ['b', 'y']);

  // A Channel without a Pet blocks the form and says why.
  await channelSelect.selectOption('z');
  await page.getByRole('status').filter({ hasText: 'This Channel has no Pet member to schedule.' }).waitFor();
  assert.equal(await submit.isDisabled(), true);
  assert.equal(await petSelect.isDisabled(), true);
  assert.equal(created.length, 1);
  assert.deepEqual(errors, []);
  console.log('Scheduler browser fixture: Pet choices follow the chosen Channel; mismatched or empty choices cannot be submitted');
} finally {
  await browser?.close(); vite?.kill();
  await new Promise((done) => server.close(done));
}
