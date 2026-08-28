import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createStudio,
  type StudioPetBinding,
} from '@pinpawo/studio';
import {
  createKanbanPlugin,
  type KanbanPlugin,
} from '@pinpawo-plugin/kanban';

import { createStudioHttpPlugin } from '@pinpawo-plugin/studio-http';

const AUTH_TOKEN = 'e2e-token-with-at-least-16-characters';

function pet(
  petId: string,
  invoke: (request: string) => Promise<void> | void,
): StudioPetBinding {
  return {
    registration: {
      petId,
      name: petId,
      role: null,
      serviceSummary: null,
    },
    dispatch: {
      getState: () => 'open',
      onStateChange: () => () => undefined,
      dispatch: async ({ request }) => { void invoke(request); },
    },
  };
}

async function waitForTask(
  plugin: KanbanPlugin,
  predicate: (task: Awaited<ReturnType<KanbanPlugin['service']['readSnapshot']>>['tasks'][number]) => boolean,
): Promise<Awaited<ReturnType<KanbanPlugin['service']['readSnapshot']>>['tasks'][number]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = (await plugin.service.readSnapshot()).tasks[0];
    if (task && predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for Kanban task state');
}

async function invokeKanbanTool(
  plugin: KanbanPlugin,
  name: string,
  input: Record<string, unknown>,
): Promise<void> {
  const declared = plugin.toolkits[0]?.tools.find(({ tool }) => tool.name === name);
  assert.ok(declared, `Kanban Plugin must define ${name}`);
  await declared.tool.invoke(input);
}

async function readSseEventsUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (events: unknown[]) => boolean,
): Promise<unknown[]> {
  const decoder = new TextDecoder();
  const events: unknown[] = [];
  let pending = '';
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timed out waiting for Studio SSE events')), 3_000);
    timer.unref();
  });
  try {
    return await Promise.race([
      (async () => {
        while (!predicate(events)) {
          const next = await reader.read();
          if (next.done) throw new Error('Studio SSE stream closed before the expected event');
          pending += decoder.decode(next.value, { stream: true });
          let boundary = pending.indexOf('\n\n');
          while (boundary >= 0) {
            const block = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            const data = block
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice('data:'.length).trimStart())
              .join('\n');
            if (data) events.push(JSON.parse(data) as unknown);
            boundary = pending.indexOf('\n\n');
          }
        }
        return events;
      })(),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('HTTP dispatch reaches a Pet and Kanban completion returns to the frontend over SSE', async (t) => {
  const kanban = createKanbanPlugin();
  const http = createStudioHttpPlugin({
    port: 0,
    authToken: AUTH_TOKEN,
    heartbeatIntervalMs: 60_000,
  });
  let writerRequest = '';

  const studio = await createStudio({
    studioId: 'http-e2e',
    entryPetId: 'planner',
    pets: [
      pet('planner', async (request) => {
        assert.equal(request, 'plan an article');
        await invokeKanbanTool(kanban, 'kanban_task_add', {
          petId: 'writer',
          brief: 'write the article',
        });
      }),
      pet('writer', async (request) => {
        writerRequest = request;
        const taskId = /Kanban taskId: ([^\s]+)/.exec(writerRequest)?.[1];
        assert.ok(taskId, 'Kanban dispatch must carry its taskId');
        await invokeKanbanTool(kanban, 'kanban_task_complete', {
          taskId,
          result: 'article ready',
        });
      }),
    ],
    plugins: [kanban, http],
  });

  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    await studio.shutdown();
  });
  const address = http.address();
  assert.ok(address);
  const authorization = { Authorization: `Bearer ${AUTH_TOKEN}` };

  const petsResponse = await fetch(
    `http://${address.host}:${address.port.toString()}/pets`,
    { headers: authorization },
  );
  assert.equal(petsResponse.status, 200);
  assert.deepEqual(await petsResponse.json(), {
    pets: [
      {
        petId: 'planner',
        name: 'planner',
        role: null,
        serviceSummary: null,
      },
      {
        petId: 'writer',
        name: 'writer',
        role: null,
        serviceSummary: null,
      },
    ],
  });

  const unauthorizedBoardResponse = await fetch(
    `http://${address.host}:${address.port.toString()}/kanban`,
  );
  assert.equal(unauthorizedBoardResponse.status, 401);

  const emptyBoardResponse = await fetch(
    `http://${address.host}:${address.port.toString()}/kanban`,
    { headers: authorization },
  );
  assert.equal(emptyBoardResponse.status, 200);
  assert.deepEqual(await emptyBoardResponse.json(), {
    tasks: [],
    lastEventSequence: 0,
    dispatchMode: 'automatic',
  });

  const eventResponse = await fetch(
    `http://${address.host}:${address.port.toString()}/events`,
    { headers: authorization, signal: controller.signal },
  );
  assert.equal(eventResponse.status, 200);
  assert.ok(eventResponse.body);
  const eventReader = eventResponse.body.getReader();
  const receivedEvents = readSseEventsUntil(
    eventReader,
    (events) => {
      const records = events.filter((event): event is Record<string, unknown> => (
        typeof event === 'object' && event !== null
      ));
      return records.some(({ type }) => type === 'task.done')
        && records.filter(({ type }) => type === 'dispatch.accepted').length >= 2;
    },
  );

  const dispatchResponse = await fetch(
    `http://${address.host}:${address.port.toString()}/dispatch`,
    {
      method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        petId: 'planner',
        request: 'plan an article',
      }),
    },
  );

  assert.equal(dispatchResponse.status, 202);
  assert.deepEqual(
    Object.keys(await dispatchResponse.json()).sort(),
    ['invocationId', 'petId'],
  );

  const events = await receivedEvents as Array<{
    type?: string;
    source?: string;
    payload?: { producer?: string; petId?: string };
  }>;
  assert.deepEqual(
    events
      .filter(({ source, type }) => source === 'studio' && type === 'dispatch.accepted')
      .map(({ payload }) => ({ producer: payload?.producer, petId: payload?.petId })),
    [
      { producer: 'http', petId: 'planner' },
      { producer: 'kanban', petId: 'writer' },
    ],
  );
  assert.deepEqual(
    events.filter(({ source }) => source === 'kanban').map(({ type }) => type),
    ['task.todo', 'task.doing', 'task.done'],
  );
  assert.match(writerRequest, /Kanban taskId:/);
  const kanbanSnapshot = await kanban.service.readSnapshot();
  assert.equal(kanbanSnapshot.tasks[0]?.status, 'done');
  assert.equal(kanbanSnapshot.tasks[0]?.note, 'article ready');

  const boardResponse = await fetch(
    `http://${address.host}:${address.port.toString()}/kanban`,
    { headers: authorization },
  );
  assert.equal(boardResponse.status, 200);
  const snapshot = await boardResponse.json() as {
    tasks: Array<{ status: string; note?: string }>;
  };
  assert.deepEqual(
    snapshot.tasks.map(({ status, note }) => ({ status, note })),
    [{ status: 'done', note: 'article ready' }],
  );

  const historyResponse = await fetch(
    `http://${address.host}:${address.port.toString()}/kanban/events?after=0`,
    { headers: authorization },
  );
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json() as {
    events: Array<{ eventType: string; sequence: number }>;
  };
  assert.deepEqual(
    history.events.map(({ eventType }) => eventType),
    ['created', 'claimed', 'completed'],
  );
  assert.deepEqual(
    history.events.map(({ sequence }) => sequence),
    [1, 2, 3],
  );
});

test('Kanban manual mode exposes an explicit task start control over HTTP', async (t) => {
  const kanban = createKanbanPlugin({ dispatchMode: 'manual' });
  const http = createStudioHttpPlugin({ port: 0, authToken: AUTH_TOKEN });
  let workerRequest = '';
  const studio = await createStudio({
    studioId: 'manual-kanban-e2e',
    entryPetId: 'worker',
    pets: [pet('worker', (request) => { workerRequest = request; })],
    plugins: [kanban, http],
  });
  t.after(() => studio.shutdown());
  const address = http.address();
  assert.ok(address);
  const authorization = { Authorization: `Bearer ${AUTH_TOKEN}` };
  const task = await kanban.service.createTask({ assigneeId: 'worker', brief: 'run manually' });

  const snapshotResponse = await fetch(
    `http://${address.host}:${address.port.toString()}/kanban`,
    { headers: authorization },
  );
  assert.equal(snapshotResponse.status, 200);
  assert.equal((await snapshotResponse.json() as { dispatchMode: string }).dispatchMode, 'manual');
  assert.equal((await kanban.service.getTask(task.task.taskId))?.status, 'todo');

  const startResponse = await fetch(
    `http://${address.host}:${address.port.toString()}/kanban/control`,
    {
      method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', taskId: task.task.taskId }),
    },
  );
  assert.equal(startResponse.status, 202);
  assert.match(workerRequest, /run manually/);
  assert.equal((await kanban.service.getTask(task.task.taskId))?.status, 'doing');
});
