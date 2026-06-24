import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPlanCapability } from './planCapability';
import type { StudioPlannerTaskInput } from './types';

test('enqueue_tasks tool captures tasks in submission order', async () => {
  let submitted: StudioPlannerTaskInput[] | null = null;
  const cap = createPlanCapability({
    enqueueTasks: (tasks) => { submitted = tasks; },
  });
  const runtime = await cap.createRuntime({} as never);
  const planToolset = runtime.toolsets![0];
  const enqueueTasksTool = planToolset.tools.find((t) => t.name === 'enqueue_tasks');
  assert.equal(planToolset.name, 'studio_plan');
  assert.equal(planToolset.operations?.list_pets?.title, '查看 pets');
  assert.equal(planToolset.operations?.enqueue_tasks?.title, '加入任务队列');
  assert.ok(enqueueTasksTool, 'enqueue_tasks tool should be available');

  const summary = planToolset.operations?.enqueue_tasks?.summarizeInput?.({
    tasks: [
      { petId: 'script', brief: '写脚本' },
      { petId: 'audio', brief: '配音' },
    ],
  });
  assert.equal(summary?.summary, '提交 2 个任务');
  assert.deepEqual(summary?.details, {
    taskCount: 2,
    petIds: ['script', 'audio'],
  });

  await enqueueTasksTool!.invoke({
    tasks: [
      { petId: 'script', brief: '写脚本' },
      { petId: 'audio', brief: '配音', deps: ['previous'] },
    ],
  });

  const tasks = submitted as StudioPlannerTaskInput[] | null;
  assert.ok(tasks, 'enqueueTasks should be called');
  assert.equal(tasks!.length, 2);
  assert.deepEqual(tasks!.map((t) => t.petId), ['script', 'audio']);
  assert.equal('status' in tasks![0], false);
  assert.equal('retryCount' in tasks![0], false);
  assert.deepEqual(tasks![0].acceptanceCriteria, []);
  assert.deepEqual(tasks![0].deps, []);
  assert.deepEqual(tasks![1].deps, ['previous']);
});

test('enqueue_tasks tool rejects empty tasks array via zod min(1)', async () => {
  let submitted: StudioPlannerTaskInput[] | null = null;
  const cap = createPlanCapability({
    enqueueTasks: (tasks) => { submitted = tasks; },
  });
  const runtime = await cap.createRuntime({} as never);
  const enqueueTasksTool = runtime.toolsets![0].tools.find((t) => t.name === 'enqueue_tasks');
  assert.ok(enqueueTasksTool, 'enqueue_tasks tool should be available');

  // schema 要求至少 1 个 task;空数组让 zod 校验失败 → langchain tool 抛错。
  // 关键约束:enqueueTasks 不应被调用。
  await assert.rejects(
    () => enqueueTasksTool!.invoke({ tasks: [] }),
    /at least 1|array|schema/i,
  );
  const tasks = submitted as StudioPlannerTaskInput[] | null;
  assert.equal(tasks, null, 'enqueueTasks must NOT be called for empty tasks');
});

test('list_pets tool returns current pets from injected closure', async () => {
  const cap = createPlanCapability({
    enqueueTasks: () => {},
    listPets: () => [
      {
        petId: 'script',
        role: 'writer',
        serviceSummary: 'writes short-form scripts',
        status: 'standby',
      },
      {
        petId: 'audio',
        role: null,
        serviceSummary: null,
        status: 'degraded',
      },
    ],
  });
  const runtime = await cap.createRuntime({} as never);
  const planToolset = runtime.toolsets![0];
  const listPetsTool = planToolset.tools.find((t) => t.name === 'list_pets');
  assert.ok(listPetsTool, 'list_pets tool should be available');

  const summary = planToolset.operations?.list_pets?.summarizeInput?.({});
  assert.equal(summary?.summary, '查看 Studio pets');

  const output = await listPetsTool!.invoke({});
  const parsed = JSON.parse(output as string) as {
    pets: Array<{
      petId: string;
      role?: string | null;
      serviceSummary?: string | null;
      status: string;
    }>;
  };
  assert.deepEqual(parsed.pets, [
    {
      petId: 'script',
      role: 'writer',
      serviceSummary: 'writes short-form scripts',
      status: 'standby',
    },
    {
      petId: 'audio',
      role: null,
      serviceSummary: null,
      status: 'degraded',
    },
  ]);

  const outputSummary = planToolset.operations?.list_pets?.summarizeOutput?.(output);
  assert.equal(outputSummary?.summary, '看到 2 个 pet');
});
