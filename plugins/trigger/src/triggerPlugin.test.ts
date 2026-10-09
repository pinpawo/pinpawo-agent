import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStudio, type StudioDispatchRequest } from '@pinpawo/studio';
import { createChannelPlugin } from '@pinpawo-plugin/channel';
import { createTriggerPlugin } from './triggerPlugin';

function channelStudioPet(petId: string, dispatched: StudioDispatchRequest[]) {
  return {
    registration: { petId, name: petId },
    dispatch: {
      getQueueSnapshot: () => ({
        state: 'open' as const, activeOperation: null, queuedConversations: 0, queuedDispatches: 0,
      }),
      onQueueChange: () => () => undefined,
      onDispatchLifecycle: () => () => undefined,
      dispatch: async (input: StudioDispatchRequest) => { dispatched.push(input); },
    },
  };
}

test('Trigger projects direct service mutations through Studio events', async (t) => {
  const plugin = createTriggerPlugin({
    httpRoute: false,
    triggers: [{
      triggerId: 'build',
      petId: 'worker',
      request: 'Handle build',
      source: { kind: 'http', secret: 'trigger-secret-with-at-least-16-characters' },
    }],
  });
  const studio = await createStudio({
    studioId: 'trigger-test',
    entryPetId: 'worker',
    pets: [{
      registration: { petId: 'worker', name: 'Worker' },
      dispatch: {
        getQueueSnapshot: () => ({
          state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0,
        }),
        onQueueChange: () => () => undefined,
        onDispatchLifecycle: () => () => undefined,
        dispatch: async () => undefined,
      },
    }],
    plugins: [plugin],
  });
  t.after(() => studio.shutdown());
  const events: string[] = [];
  studio.subscribe((event) => { events.push(event.type); });

  const claimed = await plugin.service.claim('build', 'delivery-1');
  await plugin.service.accept(claimed.delivery.deliveryId);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, ['trigger.received', 'trigger.accepted']);
});

test('Trigger dispatches when a configured Studio event condition matches', async (t) => {
  const requests: string[] = [];
  const plugin = createTriggerPlugin({
    httpRoute: false,
    triggers: [{
      triggerId: 'wiki-on-task-change',
      petId: 'wiki',
      request: {
        template: 'Update the project Wiki after {{event.type}} for {{payload.taskId}}.',
        context: ['payload.taskId', 'event.occurredAt'],
      },
      source: { kind: 'studio_event', eventSource: 'example-work', typePrefix: 'task.' },
    }],
  });
  const studio = await createStudio({
    studioId: 'trigger-event-test',
    entryPetId: 'wiki',
    pets: [{
      registration: { petId: 'wiki', name: 'Wiki' },
      dispatch: {
        getQueueSnapshot: () => ({
          state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0,
        }),
        onQueueChange: () => () => undefined,
        onDispatchLifecycle: () => () => undefined,
        dispatch: async (input) => { requests.push(input.request); },
      },
    }],
    plugins: [plugin],
  });
  t.after(() => studio.shutdown());

  studio.notify({
    source: 'example-work',
    type: 'task.completed',
    payload: { taskId: 'task-1', ignored: 'must not be appended' },
    occurredAt: '2026-08-28T00:00:00.000Z',
  });
  studio.notify({
    source: 'example-work',
    type: 'assignee.changed',
    occurredAt: '2026-08-28T00:00:01.000Z',
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests.length, 1);
  assert.match(requests[0]!, /Update the project Wiki after task\.completed for task-1/);
  assert.match(requests[0]!, /"payload\.taskId":"task-1"/);
  assert.doesNotMatch(requests[0]!, /must not be appended/);
});

test('Trigger resolves an explicit event payload target and records a retryable failed delivery', async (t) => {
  let attempts = 0;
  const plugin = createTriggerPlugin({
    httpRoute: false,
    triggers: [{
      triggerId: 'assigned-task',
      target: { kind: 'event_payload', path: 'payload.assigneeId', allowedPetIds: ['executor'] },
      request: { template: 'Start {{payload.taskId}}', context: ['payload.taskId'] },
      source: { kind: 'studio_event', eventSource: 'example-work', type: 'task.assigned' },
    }],
  });
  const studio = await createStudio({
    studioId: 'trigger-dynamic-target',
    entryPetId: 'executor',
    pets: [{
      registration: { petId: 'executor', name: 'Executor' },
      dispatch: {
        getQueueSnapshot: () => ({
          state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0,
        }), onQueueChange: () => () => undefined,
        onDispatchLifecycle: () => () => undefined,
        dispatch: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('temporary delivery failure');
        },
      },
    }],
    plugins: [plugin],
  });
  t.after(() => studio.shutdown());
  studio.notify({
    source: 'example-work', type: 'task.assigned', occurredAt: '2026-09-02T00:00:00.000Z',
    payload: { taskId: 'task-1', assigneeId: 'executor', sequence: 1 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const failed = (await plugin.service.snapshot()).deliveries[0];
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.targetPetId, 'executor');
  const retry = await plugin.service.retry(failed!.deliveryId);
  await studio.dispatch({ petId: retry.targetPetId!, request: retry.request!, idempotencyKey: `trigger:${retry.deliveryId}` });
  await plugin.service.accept(retry.deliveryId);
  assert.equal((await plugin.service.snapshot()).deliveries[0]?.status, 'accepted');
});

test('Trigger request templates reject invalid expressions and duplicate context paths', () => {
  assert.throws(() => createTriggerPlugin({
    httpRoute: false,
    triggers: [{
      triggerId: 'invalid-template',
      petId: 'worker',
      request: { template: 'Handle {{payload[taskId]}}' },
      source: { kind: 'studio_event', eventSource: 'example-work', type: 'task.done' },
    }],
  }), /invalid expression/);

  assert.throws(() => createTriggerPlugin({
    httpRoute: false,
    triggers: [{
      triggerId: 'duplicate-context',
      petId: 'worker',
      request: {
        template: 'Handle task',
        context: ['payload.taskId', 'payload.taskId'],
      },
      source: { kind: 'studio_event', eventSource: 'example-work', type: 'task.done' },
    }],
  }), /must be unique/);
});

test('a channel-bound Trigger posts into its Channel and the Pet runs there', async (t) => {
  const dispatched: StudioDispatchRequest[] = [];
  const channel = createChannelPlugin({ databasePath: ':memory:', httpRoute: false });
  channel.service.init();
  const { channelId } = channel.service.createChannel(
    { title: 'Ops', goal: 'Keep the nightly reports', scope: 'Reports only' },
    { kind: 'human', id: 'studio-operator' },
  );
  const trigger = createTriggerPlugin({
    httpRoute: false,
    triggers: [{
      triggerId: 'nightly-report',
      petId: 'reporter',
      channelId,
      request: { template: 'Report on {{payload.taskId}}' },
      source: { kind: 'studio_event', eventSource: 'example-work', type: 'task.done' },
    }],
  });
  const studio = await createStudio({
    studioId: 'trigger-channel',
    entryPetId: 'reporter',
    pets: [channelStudioPet('reporter', dispatched)],
    // Trigger starts first: the Channel hook reaches it in either order.
    plugins: [trigger, channel],
  });
  t.after(() => studio.shutdown());

  studio.notify({
    source: 'example-work', type: 'task.done', occurredAt: '2026-10-09T00:00:00.000Z',
    payload: { taskId: 'task-7' },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(dispatched.length, 1);
  const [input] = dispatched;
  // The run is the Channel's: its session and scope, with the Trigger as author.
  assert.deepEqual(input?.scope, { namespace: 'channel', id: channelId });
  assert.ok(input?.session?.id);
  assert.match(input!.request, /"participantId": "bot:nightly-report"/);
  assert.match(input!.request, /Report on task-7/);
  const messages = channel.service.readHistory(channelId).entries.filter((entry) => entry.kind === 'message');
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0]?.author, { kind: 'bot', id: 'nightly-report' });
  assert.equal((await trigger.service.snapshot()).deliveries[0]?.status, 'accepted');
});

test('a channel-bound Trigger fails its delivery when no Channel Plugin runs', async (t) => {
  const dispatched: StudioDispatchRequest[] = [];
  const trigger = createTriggerPlugin({
    httpRoute: false,
    triggers: [{
      triggerId: 'orphaned',
      petId: 'reporter',
      channelId: 'ops',
      request: 'Report',
      source: { kind: 'studio_event', eventSource: 'example-work', type: 'task.done' },
    }],
  });
  const studio = await createStudio({
    studioId: 'trigger-no-channel',
    entryPetId: 'reporter',
    pets: [channelStudioPet('reporter', dispatched)],
    plugins: [trigger],
  });
  t.after(() => studio.shutdown());
  studio.notify({ source: 'example-work', type: 'task.done', occurredAt: '2026-10-09T00:00:00.000Z' });
  await new Promise((resolve) => setImmediate(resolve));

  // Never a silent fallback to a bare dispatch into whatever session is active.
  assert.equal(dispatched.length, 0);
  const [delivery] = (await trigger.service.snapshot()).deliveries;
  assert.equal(delivery?.status, 'failed');
  assert.match(delivery?.note ?? '', /Channel Plugin/);
});
