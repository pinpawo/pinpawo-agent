import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStudio } from '@pinpawo/studio';
import { createTriggerPlugin } from './triggerPlugin';

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
      source: { kind: 'studio_event', eventSource: 'kanban', typePrefix: 'task.' },
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
    source: 'kanban',
    type: 'task.completed',
    payload: { taskId: 'task-1', ignored: 'must not be appended' },
    occurredAt: '2026-08-28T00:00:00.000Z',
  });
  studio.notify({
    source: 'kanban',
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
      source: { kind: 'studio_event', eventSource: 'kanban', type: 'task.assigned' },
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
    source: 'kanban', type: 'task.assigned', occurredAt: '2026-09-02T00:00:00.000Z',
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
      source: { kind: 'studio_event', eventSource: 'kanban', type: 'task.done' },
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
      source: { kind: 'studio_event', eventSource: 'kanban', type: 'task.done' },
    }],
  }), /must be unique/);
});
