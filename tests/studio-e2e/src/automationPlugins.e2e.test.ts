import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { createSchedulerPlugin } from '@pinpawo-plugin/scheduler';
import { createStudioHttpPlugin } from '@pinpawo-plugin/studio-http';
import { createTriggerPlugin } from '@pinpawo-plugin/trigger';
import { createStudio, type StudioPetBinding } from '@pinpawo/studio';

const STUDIO_TOKEN = 'studio-token-with-at-least-16-characters';
const TRIGGER_SECRET = 'trigger-secret-with-at-least-16-characters';

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for automation state');
}

test('Scheduler and Trigger contribute independent durable APIs through HTTP', async (t) => {
  const received: string[] = [];
  const worker: StudioPetBinding = {
    registration: { petId: 'worker', name: 'Worker', role: null, serviceSummary: null },
    dispatch: {
      getState: () => 'open',
      onStateChange: () => () => undefined,
      onDispatchLifecycle: () => () => undefined,
      dispatch: async ({ request }) => { received.push(request); },
    },
  };
  const scheduler = createSchedulerPlugin({ pollIntervalMs: 10 });
  const trigger = createTriggerPlugin({
    triggers: [{
      triggerId: 'build',
      petId: 'worker',
      request: 'Handle build notification',
      source: { kind: 'http', secret: TRIGGER_SECRET },
    }],
  });
  const http = createStudioHttpPlugin({ port: 0, authToken: STUDIO_TOKEN });
  const studio = await createStudio({
    studioId: 'automation-e2e',
    entryPetId: 'worker',
    pets: [worker],
    plugins: [scheduler, trigger, http],
  });
  t.after(() => studio.shutdown());
  const address = http.address();
  assert.ok(address);
  const base = `http://${address.host}:${address.port.toString()}`;
  const studioHeaders = {
    Authorization: `Bearer ${STUDIO_TOKEN}`,
    'Content-Type': 'application/json',
  };

  const scheduleResponse = await fetch(`${base}/scheduler`, {
    method: 'POST',
    headers: studioHeaders,
    body: JSON.stringify({
      petId: 'worker',
      request: 'scheduled request',
      runAt: new Date(Date.now() - 1000).toISOString(),
    }),
  });
  assert.equal(scheduleResponse.status, 201);
  await waitFor(async () => (await scheduler.service.snapshot()).schedules[0]?.status === 'dispatched');
  assert.ok(received.includes('scheduled request'));

  const unauthorizedTrigger = await fetch(`${base}/triggers/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ triggerId: 'build', idempotencyKey: 'build-1', payload: { ref: 'main' } }),
  });
  assert.equal(unauthorizedTrigger.status, 401);

  const invoke = () => fetch(`${base}/triggers/invoke`, {
    method: 'POST',
    headers: {
      Authorization: `Trigger ${TRIGGER_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ triggerId: 'build', idempotencyKey: 'build-1', payload: { ref: 'main' } }),
  });
  const accepted = await invoke();
  assert.equal(accepted.status, 202);
  assert.equal((await invoke()).status, 200);
  assert.equal(received.filter((request) => request.includes('build notification')).length, 1);

  const triggerSnapshot = await fetch(`${base}/triggers`, { headers: studioHeaders });
  assert.equal(triggerSnapshot.status, 200);
  const value = await triggerSnapshot.json() as {
    triggers: Array<Record<string, unknown>>;
    deliveries: Array<{ status: string }>;
  };
  assert.equal('secret' in (value.triggers[0] ?? {}), false);
  assert.deepEqual(value.deliveries.map(({ status }) => status), ['accepted']);
});

test('GitHub webhook Trigger verifies signatures, filters event action, and deduplicates delivery', async (t) => {
  const received: string[] = [];
  const worker: StudioPetBinding = {
    registration: { petId: 'reviewer', name: 'Reviewer', role: null, serviceSummary: null },
    dispatch: {
      getState: () => 'open',
      onStateChange: () => () => undefined,
      onDispatchLifecycle: () => () => undefined,
      dispatch: async ({ request }) => { received.push(request); },
    },
  };
  const githubSecret = 'github-webhook-secret-at-least-16-characters';
  const trigger = createTriggerPlugin({
    triggers: [{
      triggerId: 'github-pr-opened',
      petId: 'reviewer',
      request: {
        template: 'Review PR #{{payload.pull_request.number}} after {{source.action}}.',
        context: ['source.deliveryId', 'payload.pull_request.number'],
      },
      source: { kind: 'github', secret: githubSecret, event: 'pull_request', action: 'opened' },
    }],
  });
  const http = createStudioHttpPlugin({ port: 0, authToken: STUDIO_TOKEN });
  const studio = await createStudio({
    studioId: 'github-trigger-e2e',
    entryPetId: 'reviewer',
    pets: [worker],
    plugins: [trigger, http],
  });
  t.after(() => studio.shutdown());
  const address = http.address();
  assert.ok(address);
  const base = `http://${address.host}:${address.port.toString()}`;
  const body = JSON.stringify({ action: 'opened', pull_request: { number: 42 } });
  const signature = `sha256=${createHmac('sha256', githubSecret).update(body).digest('hex')}`;
  const request = () => fetch(`${base}/triggers/github`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': 'delivery-42',
      'X-Hub-Signature-256': signature,
    },
    body,
  });

  assert.equal((await request()).status, 202);
  assert.equal((await request()).status, 202);
  assert.equal(received.length, 1);
  assert.match(received[0]!, /Review PR #42 after opened/);
  assert.match(received[0]!, /"source.deliveryId":"delivery-42"/);

  const rejected = await fetch(`${base}/triggers/github`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': 'delivery-invalid',
      'X-Hub-Signature-256': 'sha256=invalid',
    },
    body,
  });
  assert.equal(rejected.status, 401);
});
