import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStudio } from '@pinpawo/studio';
import { createKanbanPlugin } from '@pinpawo-plugin/kanban';
import { createTriggerPlugin } from '@pinpawo-plugin/trigger';
import { createStudioHttpPlugin } from '@pinpawo-plugin/studio-http';

const AUTH_TOKEN = 'studio-e2e-auth-token';

test('Kanban HTTP assignment is user-controlled and Trigger performs the routed dispatch', async (t) => {
  const kanban = createKanbanPlugin();
  const trigger = createTriggerPlugin({
    triggers: [{
      triggerId: 'assigned-task',
      target: { kind: 'event_payload', path: 'payload.assigneeId', allowedPetIds: ['executor'] },
      request: 'Execute {{payload.taskId}}',
      source: { kind: 'studio_event', eventSource: 'kanban', type: 'task.assigned' },
    }],
  });
  const http = createStudioHttpPlugin({ port: 0, authToken: AUTH_TOKEN });
  const requests: string[] = [];
  const studio = await createStudio({
    studioId: 'http-kanban-e2e', entryPetId: 'planner',
    pets: [
      {
        registration: { petId: 'planner', name: 'Planner', role: null, serviceSummary: null },
        dispatch: {
          getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
          onQueueChange: () => () => undefined, onDispatchLifecycle: () => () => undefined, dispatch: async () => undefined,
        },
      },
      {
        registration: { petId: 'executor', name: 'Executor', role: null, serviceSummary: null },
        dispatch: {
          getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
          onQueueChange: () => () => undefined, onDispatchLifecycle: () => () => undefined, dispatch: async ({ request }) => { requests.push(request); },
        },
      },
    ],
    plugins: [kanban, trigger, http],
  });
  t.after(() => studio.shutdown());
  const address = http.address();
  assert.ok(address);
  const base = `http://${address.host}:${address.port.toString()}`;
  const headers = { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' };
  const task = await kanban.service.createTask({ title: 'Implement', detail: 'Implement the change.' });

  const before = await fetch(`${base}/kanban`, { headers });
  assert.equal(before.status, 200);
  assert.equal((await before.json() as { tasks: Array<{ status: string }> }).tasks[0]?.status, 'todo');
  assert.deepEqual(requests, []);

  const assigned = await fetch(`${base}/kanban/control`, {
    method: 'POST', headers,
    body: JSON.stringify({ action: 'assign', taskId: task.task.taskId, assigneeId: 'executor' }),
  });
  assert.equal(assigned.status, 202);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await kanban.service.getTask(task.task.taskId))?.status, 'assigned');
  assert.equal(requests.length, 1);
  assert.match(requests[0]!, new RegExp(task.task.taskId));
});
