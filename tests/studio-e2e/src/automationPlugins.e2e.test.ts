import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test, type TestContext } from 'node:test';

import { createStudioStorage } from '@pinpawo/studio-core';
import {
  ChannelService, KyselyChannelStore, channelMigrations, createChannelPlugin, type ChannelDatabase,
} from '@pinpawo-plugin/channel';
import { createSchedulerPlugin } from '@pinpawo-plugin/scheduler';
import { createNoticePlugin } from '@pinpawo-plugin/notice';
import { createStudioHttpPlugin } from '@pinpawo-plugin/studio-http';
import { createTriggerPlugin } from '@pinpawo-plugin/trigger';
import { createStudioWithPets, type LivePet } from '../../../tests/support/livePets';

const STUDIO_TOKEN = 'studio-token-with-at-least-16-characters';
const TRIGGER_SECRET = 'trigger-secret-with-at-least-16-characters';

/** Schedules and Trigger rules run their Pet in a Channel, so it exists before the Studio starts. */
async function seedChannel(t: TestContext, petIds: string[]) {
  const storage = createStudioStorage({ kind: 'sqlite', path: ':memory:' });
  t.after(() => storage.close());
  const store = new KyselyChannelStore(await storage.open<ChannelDatabase>('channel', channelMigrations(storage.dialect)));
  const service = new ChannelService({ store, pets: () => petIds.map((petId) => ({ petId, name: petId })), humans: async () => undefined });
  const { channel: { channelId } } = await service.createChannel({ kind: 'human', id: 'local' }, { title: 'Ops', pets: petIds });
  return { channelId, channel: createChannelPlugin({ store, httpRoute: false }) };
}

/** The task body inside the channel_task input a Channel run hands the Pet. */
function taskBody(request: string): string {
  return (JSON.parse(request.slice(request.indexOf('{'), request.lastIndexOf('}') + 1)) as { body: string }).body;
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for automation state');
}

test('Scheduler and Trigger contribute independent durable APIs through HTTP', async (t) => {
  const received: string[] = [];
  const worker: LivePet = {
    registration: { petId: 'worker', name: 'Worker' },
    dispatch: {
      getQueueSnapshot: () => ({
        state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0,
      }),
      onQueueChange: () => () => undefined,
      onDispatchLifecycle: () => () => undefined,
      dispatch: async ({ request }) => { received.push(taskBody(request)); },
    },
  };
  const { channelId, channel } = await seedChannel(t, ['worker']);
  const scheduler = createSchedulerPlugin({ pollIntervalMs: 10 });
  const trigger = createTriggerPlugin({
    triggers: [{
      triggerId: 'build',
      petId: 'worker',
      channelId,
      request: 'Handle build notification',
      source: { kind: 'http', secret: TRIGGER_SECRET },
    }],
  });
  const http = createStudioHttpPlugin({ port: 0, authToken: STUDIO_TOKEN });
  const studio = await createStudioWithPets({
    studioId: 'automation-e2e',
    pets: [worker],
    plugins: [scheduler, trigger, channel, http],
  });
  t.after(() => studio.shutdown());
  const address = http.address();
  assert.ok(address);
  const base = `http://${address.host}:${address.port.toString()}`;
  const studioHeaders = {
    Authorization: `Bearer ${STUDIO_TOKEN}`,
    'Content-Type': 'application/json',
  };

  // A schedule names the Channel its Pet runs in; there is no bare dispatch.
  const unbound = await fetch(`${base}/scheduler`, {
    method: 'POST',
    headers: studioHeaders,
    body: JSON.stringify({ petId: 'worker', request: 'unbound', runAt: new Date().toISOString() }),
  });
  assert.equal(unbound.status, 400);
  const scheduleResponse = await fetch(`${base}/scheduler`, {
    method: 'POST',
    headers: studioHeaders,
    body: JSON.stringify({
      petId: 'worker',
      channelId,
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

test('Scheduler queue audit creates a durable Notice without dispatching recovery work', async (t) => {
  let dispatched = 0;
  const worker: LivePet = {
    registration: { petId: 'worker', name: 'Worker' },
    dispatch: {
      getQueueSnapshot: () => ({
        state: 'blocked', activeOperation: null, queuedConversations: 0, queuedDispatches: 0,
      }),
      onQueueChange: () => () => undefined,
      onDispatchLifecycle: () => () => undefined,
      dispatch: async () => { dispatched += 1; },
    },
  };
  const notice = createNoticePlugin({
    rules: [{
      noticeId: 'blocked-queues',
      title: 'Dispatch queues need attention',
      source: {
        kind: 'studio_event',
        eventSource: 'scheduler',
        type: 'dispatch.queues_attention_required',
      },
    }],
  });
  const scheduler = createSchedulerPlugin({
    pollIntervalMs: 10,
    dispatchQueueAudit: { intervalMs: 1_000 },
  });
  const http = createStudioHttpPlugin({ port: 0, authToken: STUDIO_TOKEN });
  const studio = await createStudioWithPets({
    studioId: 'dispatch-gate-notice-e2e',
    pets: [worker],
    plugins: [http, notice, scheduler],
  });
  t.after(() => studio.shutdown());
  const address = http.address();
  assert.ok(address);
  const base = `http://${address.host}:${address.port.toString()}`;

  await waitFor(async () => (await notice.service.snapshot()).notices.length === 1);
  const response = await fetch(`${base}/notices`, {
    headers: { Authorization: `Bearer ${STUDIO_TOKEN}` },
  });
  assert.equal(response.status, 200);
  const snapshot = await response.json() as { notices: Array<{ source: string; eventType: string; payload?: unknown }> };
  assert.equal(snapshot.notices.length, 1);
  assert.equal(snapshot.notices[0]?.source, 'scheduler');
  assert.equal(snapshot.notices[0]?.eventType, 'dispatch.queues_attention_required');
  const payload = snapshot.notices[0]?.payload as {
    queues?: unknown;
    attentionStates?: unknown;
    checkedAt?: string;
  } | undefined;
  assert.deepEqual(payload?.queues, [{
    petId: 'worker', state: 'blocked', activeOperation: null, queuedConversations: 0, queuedDispatches: 0,
  }]);
  assert.deepEqual(payload?.attentionStates, ['waiting', 'blocked']);
  assert.ok(typeof payload?.checkedAt === 'string' && Number.isFinite(Date.parse(payload.checkedAt)));
  assert.equal(dispatched, 0);
});

test('GitHub webhook Trigger verifies signatures, filters event action, and deduplicates delivery', async (t) => {
  const received: string[] = [];
  const worker: LivePet = {
    registration: { petId: 'reviewer', name: 'Reviewer' },
    dispatch: {
      getQueueSnapshot: () => ({
        state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0,
      }),
      onQueueChange: () => () => undefined,
      onDispatchLifecycle: () => () => undefined,
      dispatch: async ({ request }) => { received.push(taskBody(request)); },
    },
  };
  const githubSecret = 'github-webhook-secret-at-least-16-characters';
  const { channelId, channel } = await seedChannel(t, ['reviewer']);
  const trigger = createTriggerPlugin({
    triggers: [{
      triggerId: 'github-pr-opened',
      petId: 'reviewer',
      channelId,
      request: {
        template: 'Review PR #{{payload.pull_request.number}} after {{source.action}}.',
        context: ['source.deliveryId', 'payload.pull_request.number'],
      },
      source: { kind: 'github', secret: githubSecret, event: 'pull_request', action: 'opened' },
    }],
  });
  const http = createStudioHttpPlugin({ port: 0, authToken: STUDIO_TOKEN });
  const studio = await createStudioWithPets({
    studioId: 'github-trigger-e2e',
    pets: [worker],
    plugins: [trigger, channel, http],
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
