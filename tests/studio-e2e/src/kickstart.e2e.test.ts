import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createKanbanPlugin, type KanbanPlugin } from '@pinpawo-plugin/kanban';
import { createProjectFilesPlugin } from '@pinpawo-plugin/project-files';
import { createSchedulerPlugin } from '@pinpawo-plugin/scheduler';
import { createStudioHttpPlugin } from '@pinpawo-plugin/studio-http';
import { createTriggerPlugin } from '@pinpawo-plugin/trigger';
import { createStudio, type StudioPetBinding } from '@pinpawo/studio';

const AUTH_TOKEN = 'kickstart-token-with-at-least-16-characters';

async function invokeKanbanTool(
  plugin: KanbanPlugin,
  name: string,
  input: Record<string, unknown>,
): Promise<void> {
  const declared = plugin.toolkits[0]?.tools.find(({ tool }) => tool.name === name);
  assert.ok(declared, `Kanban Plugin must define ${name}`);
  await declared.tool.invoke(input);
}

function pet(
  petId: string,
  invoke: (request: string) => Promise<void>,
): StudioPetBinding {
  return {
    registration: { petId, name: petId, role: null, serviceSummary: null },
    dispatch: {
      getState: () => 'open',
      onStateChange: () => () => undefined,
      dispatch: async ({ request }) => { await invoke(request); },
    },
  };
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for the Studio kickstart workflow');
}

test('kickstart composes HTTP, Kanban, automation, Wiki dispatch, and Markdown projection', async (t) => {
  const workdir = await mkdtemp(path.join(tmpdir(), 'pinpawo-kickstart-e2e-'));
  const wikiRoot = path.join(workdir, 'wiki');
  await mkdir(wikiRoot, { recursive: true });
  const kanban = createKanbanPlugin();
  const scheduler = createSchedulerPlugin({ pollIntervalMs: 10 });
  const trigger = createTriggerPlugin({
    triggers: [{
      triggerId: 'wiki-on-task-change',
      petId: 'wiki',
      request: 'Update project Markdown.',
      source: { kind: 'studio_event', eventSource: 'kanban', typePrefix: 'task.' },
    }],
  });
  const projectFiles = createProjectFilesPlugin({ rootDir: wikiRoot });
  const http = createStudioHttpPlugin({ port: 0, authToken: AUTH_TOKEN });
  const observed = new Map<string, string[]>();
  const record = (petId: string, request: string) => {
    const requests = observed.get(petId) ?? [];
    requests.push(request);
    observed.set(petId, requests);
  };

  const studio = await createStudio({
    studioId: 'kickstart-e2e',
    entryPetId: 'planner',
    pets: [
      pet('planner', async (request) => {
        record('planner', request);
        await invokeKanbanTool(kanban, 'kanban_task_add', {
          petId: 'executor',
          brief: 'Implement the requested change.',
        });
        const executorTask = (await kanban.service.readSnapshot()).tasks.find(
          ({ assigneeId }) => assigneeId === 'executor',
        );
        assert.ok(executorTask);
        await invokeKanbanTool(kanban, 'kanban_task_add', {
          petId: 'reviewer',
          brief: 'Review the implemented change.',
          dependsOn: [executorTask.taskId],
        });
      }),
      pet('executor', async (request) => {
        record('executor', request);
        const taskId = /Kanban taskId: ([^\s]+)/.exec(request)?.[1];
        assert.ok(taskId);
        await invokeKanbanTool(kanban, 'kanban_task_complete', {
          taskId,
          result: 'implementation complete',
        });
      }),
      pet('reviewer', async (request) => {
        record('reviewer', request);
        const taskId = /Kanban taskId: ([^\s]+)/.exec(request)?.[1];
        assert.ok(taskId);
        await invokeKanbanTool(kanban, 'kanban_task_complete', {
          taskId,
          result: 'review passed',
        });
      }),
      pet('wiki', async (request) => {
        record('wiki', request);
        const snapshot = await kanban.service.readSnapshot();
        await writeFile(
          path.join(wikiRoot, 'PROJECT.md'),
          `# Project\n\n${snapshot.tasks.map((task) => `- ${task.assigneeId}: ${task.status}`).join('\n')}\n`,
        );
      }),
    ],
    plugins: [http, kanban, scheduler, projectFiles, trigger],
  });
  t.after(() => studio.shutdown());
  const address = http.address();
  assert.ok(address);
  const base = `http://${address.host}:${address.port.toString()}`;
  const headers = { Authorization: `Bearer ${AUTH_TOKEN}` };

  const dispatch = await fetch(`${base}/dispatch`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ petId: 'planner', request: 'Deliver the Hello World change.' }),
  });
  assert.equal(dispatch.status, 202);
  await waitFor(async () => {
    const tasks = (await kanban.service.readSnapshot()).tasks;
    return tasks.length === 2 && tasks.every(({ status }) => status === 'done');
  });
  await waitFor(async () => {
    try {
      return /reviewer: done/.test(await readFile(path.join(wikiRoot, 'PROJECT.md'), 'utf8'));
    } catch {
      return false;
    }
  });

  assert.equal(observed.get('planner')?.length, 1);
  assert.equal(observed.get('executor')?.length, 1);
  assert.equal(observed.get('reviewer')?.length, 1);
  assert.match(observed.get('reviewer')?.[0] ?? '', /implementation complete/);
  assert.match(await readFile(path.join(wikiRoot, 'PROJECT.md'), 'utf8'), /reviewer: done/);

  const knowledge = await fetch(`${base}/knowledge`, { headers });
  assert.equal(knowledge.status, 200);
  assert.deepEqual(
    (await knowledge.json() as { documents: Array<{ path: string }> }).documents.map(({ path: documentPath }) => documentPath),
    ['PROJECT.md'],
  );
  const document = await fetch(`${base}/knowledge/document?path=PROJECT.md`, { headers });
  assert.equal(document.status, 200);
  assert.match(
    (await document.json() as { document: { content: string } }).document.content,
    /executor: done/,
  );
});
