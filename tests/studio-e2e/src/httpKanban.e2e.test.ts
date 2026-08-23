import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createStudio,
  type PetAgentRuntime,
  type PetAgentRuntimeInvokeInput,
} from '@pinpawo/studio';
import {
  createKanbanPlugin,
  type KanbanPlugin,
} from '@pinpawo-plugin/kanban';

import { createStudioHttpPlugin } from '@pinpawo-plugin/studio-http';

const AUTH_TOKEN = 'e2e-token-with-at-least-16-characters';

function pet(
  petId: string,
  invoke: (input: PetAgentRuntimeInvokeInput) => Promise<void> | void,
): PetAgentRuntime {
  return {
    descriptor: () => ({
      petId,
      userId: null,
      name: petId,
      personality: null,
      stage: null,
      species: null,
      role: null,
      serviceSummary: null,
      startupMode: 'standby',
      status: 'standby',
      capabilities: [],
    }),
    invoke: async (input) => {
      await invoke(input);
      return { status: 'completed', reply: 'ok' };
    },
    gate: () => 'open',
    onGateChange: () => () => undefined,
  };
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
      pet('planner', async (input) => {
        assert.deepEqual(input.input, { kind: 'request', request: 'plan an article' });
        await invokeKanbanTool(kanban, 'kanban_task_add', {
          petId: 'writer',
          brief: 'write the article',
        });
      }),
      pet('writer', async (input) => {
        assert.equal(input.input.kind, 'request');
        if (input.input.kind !== 'request') return;
        writerRequest = input.input.request;
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

  const unauthorizedBoardResponse = await fetch(
    `http://${address.host}:${address.port.toString()}/kanban`,
  );
  assert.equal(unauthorizedBoardResponse.status, 401);

  const emptyBoardResponse = await fetch(
    `http://${address.host}:${address.port.toString()}/kanban`,
    { headers: authorization },
  );
  assert.equal(emptyBoardResponse.status, 200);
  assert.deepEqual(await emptyBoardResponse.json(), { tasks: [] });

  const eventResponse = await fetch(
    `http://${address.host}:${address.port.toString()}/events`,
    { headers: authorization, signal: controller.signal },
  );
  assert.equal(eventResponse.status, 200);
  assert.ok(eventResponse.body);
  const eventReader = eventResponse.body.getReader();
  const receivedEvents = readSseEventsUntil(
    eventReader,
    (events) => events.some((event) => (
      typeof event === 'object'
      && event !== null
      && 'type' in event
      && event.type === 'task.done'
    )),
  );

  const dispatchResponse = await fetch(
    `http://${address.host}:${address.port.toString()}/dispatch`,
    {
      method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        petId: 'planner',
        input: { kind: 'request', request: 'plan an article' },
      }),
    },
  );

  assert.equal(dispatchResponse.status, 202);
  assert.deepEqual(
    Object.keys(await dispatchResponse.json()).sort(),
    ['invocationId', 'petId', 'threadId'],
  );

  const events = await receivedEvents as Array<{ type?: string; source?: string }>;
  assert.deepEqual(
    events.filter(({ source }) => source === 'kanban').map(({ type }) => type),
    ['task.todo', 'task.doing', 'task.done'],
  );
  assert.match(writerRequest, /Kanban taskId:/);
  assert.equal(kanban.board.list()[0]?.status, 'done');
  assert.equal(kanban.board.list()[0]?.note, 'article ready');

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
});
