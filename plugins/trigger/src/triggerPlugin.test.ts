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
        getState: () => 'open',
        onStateChange: () => () => undefined,
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
      request: 'Update the project Wiki Markdown in the current workdir.',
      source: { kind: 'studio_event', eventSource: 'kanban', typePrefix: 'task.' },
    }],
  });
  const studio = await createStudio({
    studioId: 'trigger-event-test',
    entryPetId: 'wiki',
    pets: [{
      registration: { petId: 'wiki', name: 'Wiki' },
      dispatch: {
        getState: () => 'open',
        onStateChange: () => () => undefined,
        dispatch: async (input) => { requests.push(input.request); },
      },
    }],
    plugins: [plugin],
  });
  t.after(() => studio.shutdown());

  studio.notify({
    source: 'kanban',
    type: 'task.completed',
    payload: { taskId: 'task-1' },
    occurredAt: '2026-08-28T00:00:00.000Z',
  });
  studio.notify({
    source: 'kanban',
    type: 'assignee.changed',
    occurredAt: '2026-08-28T00:00:01.000Z',
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests.length, 1);
  assert.match(requests[0]!, /Update the project Wiki Markdown/);
  assert.match(requests[0]!, /"taskId":"task-1"/);
});
