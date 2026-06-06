import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPlanCapability } from './planCapability';
import type { StudioTaskPlan } from './types';

test('submit_plan tool captures tasks via onSubmit, in submission order', async () => {
  let submitted: StudioTaskPlan | null = null;
  const cap = createPlanCapability({
    onSubmit: (plan) => { submitted = plan; },
  });
  const runtime = await cap.createRuntime({} as never);
  const planToolset = runtime.toolsets![0];
  const submitPlanTool = planToolset.tools[0];
  assert.equal(planToolset.name, 'studio_plan');
  assert.equal(planToolset.operations?.submit_plan?.kind, 'studio.plan.submit');
  assert.equal(planToolset.operations?.submit_plan?.title, '提交计划');

  const summary = planToolset.operations?.submit_plan?.summarizeInput?.({
    tasks: [
      { petId: 'script', goal: '写脚本' },
      { petId: 'audio', goal: '配音' },
    ],
  });
  assert.equal(summary?.summary, '提交 2 个任务');
  assert.deepEqual(summary?.details, {
    taskCount: 2,
    petIds: ['script', 'audio'],
  });

  await submitPlanTool.invoke({
    tasks: [
      { petId: 'script', goal: '写脚本' },
      { petId: 'audio',  goal: '配音' },
    ],
  });

  const plan = submitted as StudioTaskPlan | null;
  assert.ok(plan, 'onSubmit should be called');
  assert.equal(plan!.tasks.length, 2);
  assert.deepEqual(plan!.tasks.map((t) => t.petId), ['script', 'audio']);
  // 默认值
  assert.equal(plan!.tasks[0].status, 'pending');
  assert.equal(plan!.tasks[0].retryCount, 0);
  assert.deepEqual(plan!.tasks[0].acceptanceCriteria, []);
});

test('submit_plan tool rejects empty tasks array via zod min(1)', async () => {
  let submitted: StudioTaskPlan | null = null;
  const cap = createPlanCapability({
    onSubmit: (plan) => { submitted = plan; },
  });
  const runtime = await cap.createRuntime({} as never);
  const submitPlanTool = runtime.toolsets![0].tools[0];

  // schema 要求至少 1 个 task;空数组让 zod 校验失败 → langchain tool 抛错。
  // 关键约束:onSubmit 不应被调用。
  await assert.rejects(
    () => submitPlanTool.invoke({ tasks: [] }),
    /at least 1|array|schema/i,
  );
  const plan = submitted as StudioTaskPlan | null;
  assert.equal(plan, null, 'onSubmit must NOT be called for empty tasks');
});
