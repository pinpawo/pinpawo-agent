import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStudio } from '@pinpawo/studio';
import { createKanbanPlugin } from './kanbanPlugin';

test('Kanban projects a user assignment but never dispatches a Studio Pet itself', async (t) => {
  const plugin = createKanbanPlugin({ httpRoute: false });
  let dispatches = 0;
  const studio = await createStudio({
    studioId: 'kanban-plugin-test',
    entryPetId: 'planner',
    pets: [{
      registration: { petId: 'planner', name: 'Planner' },
      dispatch: {
        getQueueSnapshot: () => ({
          state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0,
        }), onQueueChange: () => () => undefined,
        onDispatchLifecycle: () => () => undefined,
        dispatch: async () => { dispatches += 1; },
      },
    }],
    plugins: [plugin],
  });
  t.after(() => studio.shutdown());
  const events: Array<{ type: string; payload?: unknown }> = [];
  studio.subscribe((event) => { events.push({ type: event.type, payload: event.payload }); });

  const task = await plugin.service.createTask({ title: 'Plan', detail: 'Create a plan.' });
  await plugin.service.assignTask(task.task.taskId, 'planner', 'Review the changed lines first.');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(dispatches, 0);
  assert.ok(events.some(({ type }) => type === 'task.assigned'));
  assert.deepEqual(events.find(({ type }) => type === 'task.assigned')?.payload, {
    taskId: task.task.taskId,
    assigneeId: 'planner',
    title: 'Plan',
    detail: 'Create a plan.',
    deps: [],
    assignmentNote: 'Review the changed lines first.',
    sequence: 2,
  });
});

test('planning and execution toolkits expose separate task responsibilities', async () => {
  const plugin = createKanbanPlugin();
  const planning = plugin.toolkits.find(({ name }) => name === 'kanban-planning');
  const execution = plugin.toolkits.find(({ name }) => name === 'kanban-execution');
  assert.deepEqual(planning?.tools.map(({ tool: value }) => value.name), ['kanban_task_list', 'kanban_task_add']);
  assert.deepEqual(execution?.tools.map(({ tool: value }) => value.name), [
    'kanban_task_list', 'kanban_task_start', 'kanban_task_complete', 'kanban_task_block',
  ]);
});
