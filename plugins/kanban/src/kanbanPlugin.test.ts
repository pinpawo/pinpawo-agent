import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { NamedStructuredTool } from '@pinpawo/pet-agent';
import {
  createStudio,
  type StudioEvent,
  type StudioPetBinding,
  type StudioPluginContext,
} from '@pinpawo/studio';

import { createKanbanPlugin } from './kanbanPlugin';
import { KanbanTaskService, SqliteKanbanTaskRepository } from './kanbanTaskService';

type KanbanTools = Record<string, NamedStructuredTool>;

function pluginTools(plugin: ReturnType<typeof createKanbanPlugin>): KanbanTools {
  const toolkit = plugin.toolkits[0];
  assert.ok(toolkit, 'kanban Plugin must define its Agent Toolkit');
  return Object.fromEntries(toolkit.tools.map(({ tool }) => [tool.name, tool])) as KanbanTools;
}

function pet(options: {
  petId: string;
  tools: () => KanbanTools;
  role?: string;
  serviceSummary?: string;
  onInvoke?: (request: string) => Promise<void> | void;
}): StudioPetBinding {
  return {
    registration: {
      petId: options.petId,
      name: options.petId,
      role: options.role ?? null,
      serviceSummary: options.serviceSummary ?? null,
    },
    dispatch: {
      getState: () => 'open',
      onStateChange: () => () => undefined,
      onDispatchLifecycle: () => () => undefined,
      dispatch: async ({ request }) => {
        void options.onInvoke?.(request);
      },
    },
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test('Studio adapter maps a committed Kanban task through dispatch and tools', async (t) => {
  const plugin = createKanbanPlugin();
  const events: StudioEvent[] = [];
  let workerRequest = '';
  const studio = await createStudio({
    studioId: 'kanban-adapter',
    entryPetId: 'planner',
    pets: [
      pet({
        petId: 'planner',
        tools: () => pluginTools(plugin),
        onInvoke: async () => {
          await pluginTools(plugin).kanban_task_add!.invoke({
            petId: 'writer',
            title: 'Write draft',
            detail: 'write draft',
          });
        },
      }),
      pet({
        petId: 'writer',
        tools: () => pluginTools(plugin),
        onInvoke: async (request) => {
          workerRequest = request;
          const taskId = /Kanban taskId: ([^\s]+)/.exec(workerRequest)?.[1];
          assert.ok(taskId);
          await pluginTools(plugin).kanban_task_complete!.invoke({ taskId, result: 'draft ready' });
        },
      }),
    ],
    plugins: [plugin],
  });
  t.after(() => studio.shutdown());
  studio.subscribe((event) => { events.push(event); });

  await studio.dispatch({
    petId: 'planner',
    request: 'prepare a draft',
  });
  await flush();

  const snapshot = await plugin.service.readSnapshot();
  assert.match(workerRequest, /Kanban taskId:/);
  assert.match(workerRequest, /Title: Write draft/);
  assert.match(workerRequest, /\n\nwrite draft\n/);
  assert.deepEqual(snapshot.tasks.map((task) => ({
    assigneeId: task.assigneeId,
    status: task.status,
    note: task.note,
  })), [{ assigneeId: 'writer', status: 'done', note: 'draft ready' }]);
  assert.deepEqual(
    (await plugin.service.listTaskEvents()).map((event) => event.eventType),
    ['created', 'claimed', 'completed'],
  );
  assert.ok(events.some((event) => event.type === 'task.done' && event.source === 'kanban'));
});

test('an accepted dispatch leaves the Kanban task active until its Toolkit reports an outcome', async (t) => {
  const plugin = createKanbanPlugin();
  const studio = await createStudio({
    studioId: 'kanban-waiting',
    entryPetId: 'worker',
    pets: [pet({
      petId: 'worker',
      tools: () => pluginTools(plugin),
    })],
    plugins: [plugin],
  });
  t.after(() => studio.shutdown());

  await pluginTools(plugin).kanban_task_add!.invoke({
    petId: 'worker',
    title: 'Needs approval',
    detail: 'needs approval',
  });
  await flush();
  const [task] = (await plugin.service.readSnapshot()).tasks;
  assert.equal(task?.status, 'doing');
  assert.equal('continuation' in (task ?? {}), false);
});

test('automatic dispatch runs one active task per Studio Pet', async (t) => {
  const plugin = createKanbanPlugin();
  const requests: string[] = [];
  const studio = await createStudio({
    studioId: 'kanban-pet-concurrency',
    entryPetId: 'planner',
    pets: [
      pet({ petId: 'planner', tools: () => pluginTools(plugin) }),
      pet({
        petId: 'worker',
        tools: () => pluginTools(plugin),
        onInvoke: async (request) => { requests.push(request); },
      }),
    ],
    plugins: [plugin],
  });
  t.after(() => studio.shutdown());

  await plugin.service.createTask({
    assigneeId: 'worker',
    title: 'First delivery',
    detail: 'finish first',
  });
  await plugin.service.createTask({
    assigneeId: 'worker',
    title: 'Second delivery',
    detail: 'finish second',
  });
  await flush();

  assert.equal(requests.length, 1);
  const initialTasks = (await plugin.service.readSnapshot()).tasks;
  assert.deepEqual(initialTasks.map(({ status }) => status).sort(), ['doing', 'todo']);
  const active = initialTasks.find(({ status }) => status === 'doing');
  assert.ok(active);

  await plugin.service.completeTask(active.taskId, 'first ready');
  await flush();
  assert.equal(requests.length, 2);
  assert.deepEqual(
    (await plugin.service.readSnapshot()).tasks.map(({ status }) => status).sort(),
    ['doing', 'done'].sort(),
  );
});

test('Kanban Toolkit lists and validates Studio Pet assignees', async (t) => {
  const plugin = createKanbanPlugin();
  const studio = await createStudio({
    studioId: 'kanban-assignees',
    entryPetId: 'planner',
    pets: [
      pet({
        petId: 'planner',
        role: 'plan work',
        serviceSummary: 'task planning',
        tools: () => pluginTools(plugin),
      }),
      pet({
        petId: 'writer',
        role: 'write output',
        serviceSummary: 'draft delivery',
        tools: () => pluginTools(plugin),
      }),
    ],
    plugins: [plugin],
  });
  t.after(() => studio.shutdown());

  const assignees = await pluginTools(plugin).kanban_assignee_list!.invoke({}) as string;
  assert.match(assignees, /petId=planner name=planner role=plan work service=task planning/);
  assert.match(assignees, /petId=writer name=writer role=write output service=draft delivery/);
  assert.match(
    await pluginTools(plugin).kanban_task_add!.invoke({
      petId: 'missing',
      title: 'Must not be persisted',
      detail: 'must not be persisted',
    }) as string,
    /unknown Studio petId/,
  );
  assert.equal((await plugin.service.readSnapshot()).tasks.length, 0);
});

test('Kanban planning Toolkit omits execution outcome tools', () => {
  const plugin = createKanbanPlugin();
  const planning = plugin.toolkits.find(({ name }) => name === 'kanban-planning');
  assert.ok(planning);
  assert.deepEqual(
    planning.tools.map(({ tool }) => tool.name),
    ['kanban_assignee_list', 'kanban_task_list', 'kanban_task_add'],
  );
});

test('Kanban execution Toolkit cannot create or reassign tasks', () => {
  const plugin = createKanbanPlugin();
  const execution = plugin.toolkits.find(({ name }) => name === 'kanban-execution');
  assert.ok(execution);
  assert.deepEqual(
    execution.tools.map(({ tool }) => tool.name),
    ['kanban_task_list', 'kanban_task_complete', 'kanban_task_block'],
  );
});

test('Kanban observation Toolkit exposes only the task snapshot', () => {
  const plugin = createKanbanPlugin();
  const observation = plugin.toolkits.find(({ name }) => name === 'kanban-observation');
  assert.ok(observation);
  assert.deepEqual(
    observation.tools.map(({ tool }) => tool.name),
    ['kanban_task_list'],
  );
});

test('Kanban assignablePetIds limits both discovery and task creation', async (t) => {
  const plugin = createKanbanPlugin({ assignablePetIds: ['writer'] });
  const studio = await createStudio({
    studioId: 'kanban-configured-assignees',
    entryPetId: 'planner',
    pets: [
      pet({ petId: 'planner', tools: () => pluginTools(plugin) }),
      pet({ petId: 'writer', tools: () => pluginTools(plugin) }),
    ],
    plugins: [plugin],
  });
  t.after(() => studio.shutdown());

  const assignees = await pluginTools(plugin).kanban_assignee_list!.invoke({}) as string;
  assert.doesNotMatch(assignees, /petId=planner/);
  assert.match(assignees, /petId=writer/);
  assert.match(
    await pluginTools(plugin).kanban_task_add!.invoke({
      petId: 'planner',
      title: 'Must remain planning-only',
      detail: 'must remain planning-only',
    }) as string,
    /unknown Studio petId/,
  );
  assert.match(
    await pluginTools(plugin).kanban_task_add!.invoke({
      petId: 'writer',
      title: 'Deliver the implementation',
      detail: 'deliver the implementation',
    }) as string,
    /added/,
  );
  assert.deepEqual(
    (await plugin.service.readSnapshot()).tasks.map(({ assigneeId }) => assigneeId),
    ['writer'],
  );
});

test('Kanban startup rejects assignable Pet ids outside the Studio registry', async () => {
  const plugin = createKanbanPlugin({ assignablePetIds: ['missing'] });
  await assert.rejects(
    createStudio({
      studioId: 'kanban-invalid-assignee',
      entryPetId: 'planner',
      pets: [pet({ petId: 'planner', tools: () => pluginTools(plugin) })],
      plugins: [plugin],
    }),
    /assignable petId "missing" is not registered/,
  );
});

test('downstream dispatch includes completed dependency results', async (t) => {
  const plugin = createKanbanPlugin();
  const requests: string[] = [];
  const studio = await createStudio({
    studioId: 'kanban-dependency-results',
    entryPetId: 'writer',
    pets: [pet({
      petId: 'writer',
      tools: () => pluginTools(plugin),
      onInvoke: (request) => { requests.push(request); },
    })],
    plugins: [plugin],
  });
  t.after(() => studio.shutdown());

  const first = await plugin.service.createTask({
    assigneeId: 'writer',
    title: 'Produce the outline',
    detail: 'produce the outline',
  });
  await flush();
  await plugin.service.completeTask(first.task.taskId, 'outline is ready');
  await plugin.service.createTask({
    assigneeId: 'writer',
    title: 'Write the article',
    detail: 'write the article',
    dependsOn: [first.task.taskId],
  });
  await flush();

  assert.match(requests.at(-1) ?? '', /Completed dependency results:/);
  assert.match(requests.at(-1) ?? '', /outline is ready/);
});

test('a late Toolkit report completes an active task independently of dispatch lifetime', async (t) => {
  const plugin = createKanbanPlugin();
  const studio = await createStudio({
    studioId: 'kanban-unreported',
    entryPetId: 'worker',
    pets: [pet({ petId: 'worker', tools: () => pluginTools(plugin) })],
    plugins: [plugin],
  });
  t.after(() => studio.shutdown());

  await pluginTools(plugin).kanban_task_add!.invoke({
    petId: 'worker',
    title: 'Must report',
    detail: 'must report',
  });
  await flush();
  const [task] = (await plugin.service.readSnapshot()).tasks;
  assert.equal(task?.status, 'doing');
  assert.match(
    await pluginTools(plugin).kanban_task_complete!.invoke({
      taskId: task!.taskId,
      result: 'reported after recovery',
    }) as string,
    /completed/,
  );
  assert.equal((await plugin.service.getTask(task!.taskId))?.status, 'done');
});

test('a dispatch admission failure blocks the already-claimed task', async (t) => {
  const plugin = createKanbanPlugin();
  const studio = await createStudio({
    studioId: 'kanban-admission-failure',
    entryPetId: 'worker',
    pets: [pet({
      petId: 'worker',
      tools: () => pluginTools(plugin),
      onInvoke: () => { throw new Error('resident unavailable'); },
    })],
    plugins: [plugin],
  });
  t.after(() => studio.shutdown());

  await pluginTools(plugin).kanban_task_add!.invoke({
    petId: 'worker',
    title: 'Cannot deliver',
    detail: 'cannot deliver',
  });
  await flush();
  const [task] = (await plugin.service.readSnapshot()).tasks;
  assert.equal(task?.status, 'blocked');
  assert.match(task?.note ?? '', /resident unavailable/);
});

test('adapter startup recovers SQLite doing work as blocked before it can redispatch', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-kanban-adapter-'));
  const databasePath = path.join(root, 'kanban.sqlite');
  const first = new KanbanTaskService(new SqliteKanbanTaskRepository(databasePath));
  await first.init();
  const task = await first.createTask({
    assigneeId: 'worker',
    title: 'Unknown outcome',
    detail: 'unknown outcome',
  });
  await first.claimNextReadyTask();
  await first.close();

  const recoveredService = new KanbanTaskService(new SqliteKanbanTaskRepository(databasePath));
  const plugin = createKanbanPlugin({ service: recoveredService });
  let invocationCount = 0;
  const studio = await createStudio({
    studioId: 'kanban-recovery',
    entryPetId: 'worker',
    pets: [pet({
      petId: 'worker',
      tools: () => pluginTools(plugin),
      onInvoke: () => { invocationCount += 1; },
    })],
    plugins: [plugin],
  });
  t.after(async () => {
    await studio.shutdown();
    await recoveredService.close();
  });

  await flush();
  assert.equal(invocationCount, 0);
  assert.equal((await recoveredService.getTask(task.task.taskId))?.status, 'blocked');
});

test('Studio-facing tools reject unknown task ids without leaking repository errors', async () => {
  const plugin = createKanbanPlugin();
  const studio = await createStudio({
    studioId: 'kanban-tools',
    entryPetId: 'worker',
    pets: [pet({ petId: 'worker', tools: () => pluginTools(plugin) })],
    plugins: [plugin],
  });
  try {
    assert.match(
      await pluginTools(plugin).kanban_task_complete!.invoke({ taskId: 'missing', result: 'x' }) as string,
      /unknown Kanban taskId/,
    );
  } finally {
    await studio.shutdown();
  }
});

test('failed secondary HTTP route registration removes the first route', async () => {
  const plugin = createKanbanPlugin();
  const registeredPaths = new Set<string>();
  const context = {
    dispatch: async () => { throw new Error('not used'); },
    notify: () => undefined,
    subscribe: () => () => undefined,
    listPets: () => [],
    hooks: {
      expose: () => () => undefined,
      contribute: (_pluginName: string, _hookName: string, install: (routes: {
        register: (route: { path: string }) => () => void;
      }) => void | (() => void)) => {
        install({
          register: (route) => {
            if (registeredPaths.size > 0) throw new Error('second route rejected');
            registeredPaths.add(route.path);
            return () => { registeredPaths.delete(route.path); };
          },
        });
        return () => undefined;
      },
    },
  } as unknown as StudioPluginContext;

  await assert.rejects(Promise.resolve(plugin.start(context)), /second route rejected/);
  assert.deepEqual([...registeredPaths], []);
});
