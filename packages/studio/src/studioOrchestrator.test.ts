import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStudioOrchestrator } from './createStudioOrchestrator';
import { InMemoryStudioRunQueueStore } from './runQueuePort';
import type { WikiCurator } from './wikiPort';
import type {
  PetAgentRuntime,
  PetAgentRuntimeDescriptor,
  PetAgentRuntimeInvokeInput,
  PetAgentRuntimeInvokeResult,
} from './types';
import type { AgentCapability } from '@pinpawo/pet-agent';
import type {
  StudioOrchestrator,
  StudioRunEvent,
  StudioSubmitRequestInput,
  StudioTurnEvent,
} from './types';

type PlannerStubTaskBatch = {
  tasks: Array<{
    petId: string;
    goal: string;
    acceptanceCriteria: string[];
    deps?: Array<'previous' | { taskIndex: number }>;
  }>;
};

type StudioPlannerStubRequestInput = StudioSubmitRequestInput & {
  plan?: PlannerStubTaskBatch;
};

const pendingPlannerStubBatches = new Map<string, PlannerStubTaskBatch>();

function findInjectedToolkitTool(
  input: PetAgentRuntimeInvokeInput,
  toolkitName: string,
  toolName: string,
) {
  return input.toolkits
    ?.find((toolkit) => toolkit.name === toolkitName)
    ?.tools.find((definition) => definition.tool.name === toolName)
    ?.tool;
}

function runtime(params: {
  petId: string;
  name: string;
  reply: string;
  role?: string | null;
  serviceSummary?: string | null;
  startupMode?: PetAgentRuntimeDescriptor['startupMode'];
  status?: PetAgentRuntimeDescriptor['status'];
  onInvoke?: (input: PetAgentRuntimeInvokeInput) => void | Promise<void>;
}): PetAgentRuntime {
  const descriptor: PetAgentRuntimeDescriptor = {
    petId: params.petId,
    userId: 'user-1',
    name: params.name,
    personality: null,
    stage: null,
    species: null,
    role: params.role ?? null,
    serviceSummary: params.serviceSummary ?? null,
    startupMode: params.startupMode ?? 'standby',
    status: params.status ?? 'standby',
    capabilities: [],
  };

  return {
    descriptor: () => descriptor,
    invoke: async (input: PetAgentRuntimeInvokeInput): Promise<PetAgentRuntimeInvokeResult> => {
      const plannerStubBatch = pendingPlannerStubBatches.get(input.brief);
      if (plannerStubBatch && input.extraCapabilities?.some((cap) => cap.name === 'studio_plan')) {
        pendingPlannerStubBatches.delete(input.brief);
        const enqueueTool = findInjectedToolkitTool(input, 'studio_plan', 'enqueue_tasks');
        assert.ok(enqueueTool, 'studio_plan should expose enqueue_tasks');
        await enqueueTool!.invoke({
          tasks: plannerStubBatch.tasks.map((task) => ({
            petId: task.petId,
            brief: task.goal,
            acceptanceCriteria: task.acceptanceCriteria ?? [],
            deps: task.deps ?? [],
          })),
        });
        return { reply: 'planned debug tasks' };
      }
      await params.onInvoke?.(input);
      return { reply: params.reply };
    },
  };
}

function plannerRuntime(petId = 'planner'): PetAgentRuntime {
  return runtime({ petId, name: 'Planner', reply: 'planned' });
}

/**
 * 记录型 curator:报告一次变更但不落盘。
 * 编排核心只依赖 WikiCurator 接口,真正的文件实现住在 toolkit 层。
 */
function recordingCurator(): WikiCurator {
  return {
    curate: async ({ task }) => ({
      changedPaths: [`sources/${task.petRunId}-${task.petId}.md`, 'index.md'],
    }),
  };
}

async function makeWikiTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runStudio(
  orchestrator: StudioOrchestrator,
  input: StudioPlannerStubRequestInput,
) {
  const accepted = await submitWithPlannerStub(orchestrator, input);
  return await orchestrator.waitForRun(accepted.runId);
}

async function submitWithPlannerStub(
  orchestrator: StudioOrchestrator,
  input: StudioPlannerStubRequestInput,
) {
  const { plan, ...submitInput } = input;
  if (plan) {
    pendingPlannerStubBatches.set(submitInput.userRequest, plan);
  }
  return await orchestrator.submitRequest(submitInput);
}

test('studio orchestrator exposes standby pet agents in context', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-ctx-');
  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    defaultPetId: 'script',
    wikiBaseDir,
    plannerPetId: 'planner',
    agents: [
      plannerRuntime(),
      runtime({ petId: 'script', name: 'Script Pet', reply: 'script done' }),
      runtime({ petId: 'audio', name: 'Audio Pet', reply: 'audio done' }),
    ],
  });

  const context = orchestrator.context();
  assert.equal(context.studioId, 'studio-1');
  assert.equal(context.defaultPetId, 'script');
  assert.deepEqual(context.agents.map((agent) => agent.petId), ['planner', 'script', 'audio']);
});

test('studio orchestrator dispatches planned tasks sequentially and finishes with last result', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-seq-');
  const briefs: string[] = [];
  const wikiRoots: (string | undefined)[] = [];
  const workdirs: (string | undefined)[] = [];

  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    wikiBaseDir,
    workdir: '/tmp/pinpawo-studio-workdir',
    plannerPetId: 'planner',
    agents: [
      plannerRuntime(),
      runtime({
        petId: 'script',
        name: 'Script Pet',
        reply: 'script done',
        onInvoke: (input) => {
          briefs.push(input.brief);
          wikiRoots.push(input.wikiRoot);
          workdirs.push(input.workdir);
        },
      }),
      runtime({
        petId: 'audio',
        name: 'Audio Pet',
        reply: 'audio done',
        onInvoke: (input) => {
          briefs.push(input.brief);
          wikiRoots.push(input.wikiRoot);
          workdirs.push(input.workdir);
        },
      }),
    ],
  });

  const result = await runStudio(orchestrator, {
    userRequest: '帮我开始写视频脚本',
    turnId: 'turn-1',
    conversationId: 'conv-1',
    plan: {
      tasks: [
        {
          petId: 'script',
          goal: '写视频脚本结构',
          acceptanceCriteria: [],
        },
        {
          petId: 'audio',
          goal: '评估尾音频需求,整合输出',
          acceptanceCriteria: [],
        },
      ],
    },
  });

  assert.equal(result.turnId, 'turn-1');
  assert.equal(result.outcome.outcome, 'done');
  if (result.outcome.outcome === 'done') {
    assert.equal(result.outcome.reply, 'audio done');
    assert.equal(result.outcome.finalTaskIndex, 1);
    assert.equal(result.outcome.finalPetRunId, result.snapshot.finalPetRunId);
  }
  assert.equal(result.snapshot.tasks.length, 2);
  assert.deepEqual(
    result.snapshot.tasks.map((task) => task.status),
    ['done', 'done'],
  );
  assert.equal(result.snapshot.finalTaskIndex, 1);
  assert.equal(result.snapshot.finalPetRunId, result.snapshot.tasks[1].petRunId);
  assert.deepEqual(briefs, ['写视频脚本结构', '评估尾音频需求,整合输出']);
  assert.deepEqual(workdirs, ['/tmp/pinpawo-studio-workdir', '/tmp/pinpawo-studio-workdir']);
  // 所有 dispatch 都拿到 wikiRoot
  assert.equal(wikiRoots.length, 2);
  for (const root of wikiRoots) {
    assert.ok(root, 'wikiRoot should be injected');
    assert.ok(root!.includes('conv-1'), 'wikiRoot should be namespaced by conversationId');
  }
  // 最终标定的是末位完成 task 对应的 pet run.
  if (result.outcome.outcome === 'done') {
    assert.equal(result.outcome.finalPetRunId, result.snapshot.tasks[1].petRunId);
  }
});

test('studio orchestrator emits onTurnEvent lifecycle for happy path', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-turn-event-');
  const events: StudioTurnEvent[] = [];

  const orchestrator = createStudioOrchestrator({
    curator: recordingCurator(),
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    wikiBaseDir,
    plannerPetId: 'planner',
    agents: [
      plannerRuntime(),
      runtime({ petId: 'script', name: 'Script Pet', reply: 'script done' }),
    ],
  });

  const result = await runStudio(orchestrator, {
    userRequest: '写脚本',
    turnId: 'turn-evt-1',
    conversationId: 'conv-evt-1',
    onTurnEvent: (event) => { events.push(event); },
    plan: {
      tasks: [
        {
          petId: 'script',
          goal: '写脚本结构',
          acceptanceCriteria: [],
        },
      ],
    },
  });

  assert.equal(result.outcome.outcome, 'done');

  // 期待事件顺序:turn_started → tasks_queued → task_started → task_status_changed(satisfied)
  // → task_finished → wiki_updated → turn_finished
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    'turn_started',
    'tasks_queued',
    'task_started',
    'task_status_changed',
    'task_finished',
    'wiki_updated',
    'turn_finished',
  ]);

  const started = events[0] as Extract<StudioTurnEvent, { type: 'turn_started' }>;
  assert.equal(started.turnId, 'turn-evt-1');
  assert.equal(started.userRequest, '写脚本');

  const finished = events.at(-1) as Extract<StudioTurnEvent, { type: 'turn_finished' }>;
  assert.equal(finished.outcome, 'done');
  assert.ok(finished.finalPetRunId);

  const taskFinished = events.find((e) => e.type === 'task_finished') as Extract<StudioTurnEvent, { type: 'task_finished' }>;
  assert.equal(taskFinished.status, 'finished');
  assert.equal(taskFinished.resultText, 'script done');
  assert.ok(taskFinished.petRunId);
});

test('studio orchestrator emits turn_started then turn_finished(stopped) when planner has no plan', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-no-plan-');
  const events: StudioTurnEvent[] = [];

  // 不传 explicit plan + 没注册 planner 之外的 agent + planner 返回空 reply → 期望 stopped
  // planner pet 返回空,没有 capability 被调用,Studio 捕获不到入队任务
  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    wikiBaseDir,
    plannerPetId: 'planner',
    agents: [
      runtime({ petId: 'planner', name: 'Planner', reply: '' }),
    ],
  });

  await runStudio(orchestrator, {
    userRequest: '随便',
    conversationId: 'conv-no-plan',
    onTurnEvent: (event) => { events.push(event); },
    // 不传 plan → 走 planner 流程
  });

  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['turn_started', 'turn_finished']);
  const finished = events[1] as Extract<StudioTurnEvent, { type: 'turn_finished' }>;
  assert.equal(finished.outcome, 'stopped');
});

test('studio orchestrator surfaces failed pet as task failed and stops when no result available', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-fail-');
  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    wikiBaseDir,
    plannerPetId: 'planner',
    maxRetryPerTask: 1,
    agents: [
      plannerRuntime(),
      {
        descriptor: () => ({
          petId: 'broken',
          userId: 'user-1',
          name: 'Broken Pet',
          personality: null,
          stage: null,
          species: null,
          role: null,
          serviceSummary: null,
          startupMode: 'standby',
          status: 'standby',
          capabilities: [],
        }),
        invoke: async () => {
          throw new Error('pet exploded');
        },
      },
    ],
  });

  const result = await runStudio(orchestrator, {
    userRequest: '试试',
    conversationId: 'conv-fail-1',
    plan: {
      tasks: [
        {
          petId: 'broken',
          goal: '不可能完成的任务',
          acceptanceCriteria: [],
        },
      ],
    },
  });

  assert.equal(result.outcome.outcome, 'stopped');
  assert.equal(result.snapshot.tasks[0].petId, 'broken');
  assert.equal(result.snapshot.tasks[0].status, 'failed');
  assert.match(result.snapshot.tasks[0].errorMessage ?? '', /pet exploded/);
});

test('studio runner requeues failed task until retry limit is reached', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-retry-');
  let attempts = 0;
  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    wikiBaseDir,
    plannerPetId: 'planner',
    maxRetryPerTask: 2,
    agents: [
      plannerRuntime(),
      {
        descriptor: () => ({
          petId: 'worker',
          userId: 'user-1',
          name: 'Retry Worker',
          personality: null,
          stage: null,
          species: null,
          role: null,
          serviceSummary: null,
          startupMode: 'standby',
          status: 'standby',
          capabilities: [],
        }),
        invoke: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error('temporary failure');
          }
          return { reply: 'retried done' };
        },
      },
    ],
  });

  const result = await runStudio(orchestrator, {
    userRequest: 'retry task',
    conversationId: 'conv-retry-1',
    plan: {
      tasks: [
        {
          petId: 'worker',
          goal: 'do retryable work',
          acceptanceCriteria: [],
        },
      ],
    },
  });

  assert.equal(result.outcome.outcome, 'done');
  assert.equal(attempts, 2);
  assert.equal(result.snapshot.tasks.length, 1);
  assert.equal(result.snapshot.tasks[0].status, 'done');
  assert.equal(result.outcome.outcome === 'done' ? result.outcome.reply : '', 'retried done');
});

test('studio runner does not dispatch queued tasks after signal is already aborted', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-cancel-');
  const abortController = new AbortController();
  abortController.abort();
  let workerInvoked = false;
  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    wikiBaseDir,
    plannerPetId: 'worker',
    agents: [
      plannerRuntime(),
      runtime({
        petId: 'worker',
        name: 'Worker',
        reply: 'should not run',
        onInvoke: () => {
          workerInvoked = true;
        },
      }),
    ],
  });

  const result = await runStudio(orchestrator, {
    userRequest: 'cancel task',
    turnId: 'run-cancel',
    conversationId: 'conv-cancel',
    signal: abortController.signal,
    plan: {
      tasks: [
        {
          petId: 'worker',
          goal: 'do cancelled work',
          acceptanceCriteria: [],
        },
      ],
    },
  });

  assert.equal(result.outcome.outcome, 'stopped');
  assert.equal(result.outcome.reason, 'aborted by signal');
  assert.equal(workerInvoked, false);
  assert.equal(orchestrator.getRun('run-cancel')?.status, 'cancelled');
});

test('studio invokes planner agent when no explicit plan, captures submitted plan and dispatches it', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-planner-');

  // 模拟 planner pet:当它被 invoke 时,模拟 LLM 调 enqueue_tasks 工具
  // 把 tasks 通过 extraCapabilities 的 plan capability 提交出来
  const plannerInvocations: PetAgentRuntimeInvokeInput[] = [];
  const planner: PetAgentRuntime = {
    descriptor: () => ({
      petId: 'planner',
      userId: 'user-1',
      name: 'Planner',
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
      plannerInvocations.push(input);
      const planCap = (input.extraCapabilities ?? []).find(
        (cap: AgentCapability) => cap.name === 'studio_plan',
      );
      assert.ok(planCap, 'planner should receive studio_plan capability');
      const listPetsTool = findInjectedToolkitTool(input, 'studio_plan', 'list_pets');
      assert.ok(listPetsTool, 'list_pets tool should be available');
      const petsOutput = await listPetsTool!.invoke({});
      const pets = (JSON.parse(petsOutput as string) as {
        pets: Array<{
          petId: string;
          role?: string | null;
          serviceSummary?: string | null;
          status: string;
        }>;
      }).pets;
      assert.deepEqual(
        pets.find((pet) => pet.petId === 'worker'),
        {
          petId: 'worker',
          role: 'executor',
          serviceSummary: 'handles queued work',
          status: 'degraded',
        },
      );
      const enqueueTool = findInjectedToolkitTool(input, 'studio_plan', 'enqueue_tasks');
      assert.ok(enqueueTool, 'enqueue_tasks tool should be available');
      // 模拟 LLM 调 tool 提交 tasks
      await enqueueTool!.invoke({
        tasks: [
          { petId: 'worker', brief: 'do the work', acceptanceCriteria: ['done'] },
        ],
      });
      return { reply: '已规划 1 棒' };
    },
  };

  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    wikiBaseDir,
    plannerPetId: 'planner',
    agents: [
      planner,
      runtime({
        petId: 'worker',
        name: 'Worker',
        reply: 'worker done',
        role: 'executor',
        serviceSummary: 'handles queued work',
        status: 'degraded',
      }),
    ],
  });

  const result = await runStudio(orchestrator, {
    userRequest: '请帮我完成任务',
    conversationId: 'conv-planner-1',
  });

  // planner 被 invoke 一次
  assert.equal(plannerInvocations.length, 1);
  assert.equal(plannerInvocations[0].brief, '请帮我完成任务');
  assert.match(plannerInvocations[0].threadId ?? '', /planner$/);

  // plan 被捕获 + dispatch 顺利执行
  assert.equal(result.outcome.outcome, 'done');
  assert.equal(result.snapshot.tasks.length, 1);
  assert.equal(result.snapshot.tasks[0].petId, 'worker');
  assert.equal(result.snapshot.tasks[0].status, 'done');
  if (result.outcome.outcome === 'done') {
    assert.equal(result.outcome.reply, 'worker done');
  }
});

test('studio uses injected curator instead of skeleton default', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-curator-');
  const curatedPetRunIds: string[] = [];

  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    wikiBaseDir,
    plannerPetId: 'worker',
    curator: {
      curate: async ({ task }) => {
        curatedPetRunIds.push(task.petRunId ?? '');
        return { changedPaths: [`custom/${task.petRunId}.md`] };
      },
    },
    agents: [
      plannerRuntime(),
      runtime({ petId: 'worker', name: 'Worker', reply: 'done' }),
    ],
  });

  const result = await runStudio(orchestrator, {
    userRequest: '随便',
    conversationId: 'conv-curator-1',
    plan: {
      tasks: [
        {
          petId: 'worker',
          goal: '工作',
          acceptanceCriteria: [],
        },
      ],
    },
  });

  assert.equal(result.outcome.outcome, 'done');
  assert.equal(curatedPetRunIds.length, 1);
  assert.equal(curatedPetRunIds[0], result.snapshot.tasks[0].petRunId);
});

test('studio stops when planner did not enqueue tasks', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-planner-fail-');
  const planner: PetAgentRuntime = {
    descriptor: () => ({
      petId: 'planner',
      userId: 'user-1',
      name: 'Planner',
      personality: null,
      stage: null,
      species: null,
      role: null,
      serviceSummary: null,
      startupMode: 'standby',
      status: 'standby',
      capabilities: [],
    }),
    invoke: async () => ({ reply: '信息不足,需要用户补充目标受众' }),
  };
  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    wikiBaseDir,
    plannerPetId: 'planner',
    agents: [planner],
  });

  const result = await runStudio(orchestrator, {
    userRequest: '帮我',
    conversationId: 'conv-planner-fail-1',
  });

  assert.equal(result.outcome.outcome, 'stopped');
  if (result.outcome.outcome === 'stopped') {
    assert.match(result.outcome.reason, /planner did not enqueue tasks/);
    assert.match(result.outcome.reply, /信息不足/);
  }
});

test('pet agent thread id is namespaced per dispatch', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-thread-');
  const threadIds: string[] = [];
  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    wikiBaseDir,
    plannerPetId: 'planner',
    agents: [
      plannerRuntime(),
      runtime({
        petId: 'script',
        name: 'Script Pet',
        reply: 'script done',
        onInvoke: (input) => {
          if (input.threadId) threadIds.push(input.threadId);
        },
      }),
    ],
  });

  await runStudio(orchestrator, {
    userRequest: '继续',
    conversationId: 'conv-thread-1',
    plan: {
      tasks: [
        {
          petId: 'script',
          goal: '走一棒',
          acceptanceCriteria: [],
        },
      ],
    },
  });

  assert.equal(threadIds.length, 1);
  assert.match(
    threadIds[0],
    /studio:studio-1:thread:conv-thread-1:pet:script:dispatch:[a-f0-9]{8}/,
  );
});

test('studio request planning is not serialized through the worker task queue', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-queue-');
  const events: string[] = [];
  let releaseFirstPlanner!: () => void;
  let markFirstPlannerStarted!: () => void;
  let markSecondPlannerStarted!: () => void;
  const firstPlannerStarted = new Promise<void>((resolve) => {
    markFirstPlannerStarted = resolve;
  });
  const secondPlannerStarted = new Promise<void>((resolve) => {
    markSecondPlannerStarted = resolve;
  });
  const firstPlannerGate = new Promise<void>((resolve) => {
    releaseFirstPlanner = resolve;
  });

  const planner: PetAgentRuntime = {
    descriptor: () => ({
      petId: 'planner',
      userId: 'user-1',
      name: 'Planner',
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
      events.push(`planner:${input.brief}`);
      if (input.brief === 'first') {
        markFirstPlannerStarted();
        await firstPlannerGate;
      }
      if (input.brief === 'second') {
        markSecondPlannerStarted();
      }
      const planCap = (input.extraCapabilities ?? []).find(
        (cap: AgentCapability) => cap.name === 'studio_plan',
      );
      assert.ok(planCap, 'planner should receive studio_plan capability');
      const enqueueTool = findInjectedToolkitTool(input, 'studio_plan', 'enqueue_tasks');
      assert.ok(enqueueTool, 'enqueue_tasks tool should be available');
      await enqueueTool!.invoke({
        tasks: [
          {
            petId: 'worker',
            brief: `work:${input.brief}`,
            acceptanceCriteria: [],
          },
        ],
      });
      return { reply: `planned:${input.brief}` };
    },
  };

  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    wikiBaseDir,
    plannerPetId: 'planner',
    agents: [
      planner,
      runtime({
        petId: 'worker',
        name: 'Worker',
        reply: 'worker done',
        onInvoke: (input) => {
          events.push(`worker:${input.brief}`);
        },
      }),
    ],
  });

  const first = await orchestrator.submitRequest({
    userRequest: 'first',
    turnId: 'run-1',
    conversationId: 'conv-queue',
  });
  await firstPlannerStarted;

  const second = await orchestrator.submitRequest({
    userRequest: 'second',
    turnId: 'run-2',
    conversationId: 'conv-queue',
  });
  await secondPlannerStarted;
  assert.deepEqual(first, { runId: 'run-1', status: 'accepted' });
  assert.deepEqual(second, { runId: 'run-2', status: 'accepted' });
  assert.ok(
    events.includes('planner:second'),
    'second request should enter planning while first planner is still running',
  );

  releaseFirstPlanner();
  const [firstResult, secondResult] = await Promise.all([
    orchestrator.waitForRun('run-1'),
    orchestrator.waitForRun('run-2'),
  ]);

  assert.equal(firstResult.outcome.outcome, 'done');
  assert.equal(secondResult.outcome.outcome, 'done');
  assert.equal(events[0], 'planner:first');
  assert.ok(events.includes('worker:work:first'));
  assert.ok(events.includes('worker:work:second'));
  assert.ok(
    events.indexOf('planner:second') < events.indexOf('worker:work:second'),
    'second run task should only execute after second request is planned',
  );
});

test('studio runner dispatches no-deps tasks after previous tasks are sent, without waiting for completion', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-fifo-admission-');
  const events: string[] = [];
  let releaseFirstWorker!: () => void;
  let markFirstWorkerStarted!: () => void;
  let markSecondWorkerStarted!: () => void;
  const firstWorkerStarted = new Promise<void>((resolve) => {
    markFirstWorkerStarted = resolve;
  });
  const secondWorkerStarted = new Promise<void>((resolve) => {
    markSecondWorkerStarted = resolve;
  });
  const firstWorkerGate = new Promise<void>((resolve) => {
    releaseFirstWorker = resolve;
  });

  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    wikiBaseDir,
    plannerPetId: 'worker-a',
    agents: [
      plannerRuntime(),
      runtime({
        petId: 'worker-a',
        name: 'Worker A',
        reply: 'a done',
        onInvoke: async (input) => {
          events.push(`worker-a:${input.brief}`);
          markFirstWorkerStarted();
          await firstWorkerGate;
        },
      }),
      runtime({
        petId: 'worker-b',
        name: 'Worker B',
        reply: 'b done',
        onInvoke: (input) => {
          events.push(`worker-b:${input.brief}`);
          markSecondWorkerStarted();
        },
      }),
    ],
  });

  await submitWithPlannerStub(orchestrator, {
    userRequest: 'parallel no deps',
    turnId: 'run-fifo-admission',
    conversationId: 'conv-fifo-admission',
    plan: {
      tasks: [
        { petId: 'worker-a', goal: 'first work', acceptanceCriteria: [] },
        { petId: 'worker-b', goal: 'second work', acceptanceCriteria: [] },
      ],
    },
  });

  await firstWorkerStarted;
  await secondWorkerStarted;
  assert.deepEqual(events, ['worker-a:first work', 'worker-b:second work']);

  releaseFirstWorker();
  const result = await orchestrator.waitForRun('run-fifo-admission');
  assert.equal(result.outcome.outcome, 'done');
  assert.deepEqual(result.snapshot.tasks.map((task) => task.status), ['done', 'done']);
});

test('studio runner does not skip a queued head task even when later no-deps task is dispatchable', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-fifo-head-blocked-');
  const events: string[] = [];

  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    wikiBaseDir,
    plannerPetId: 'worker-a',
    agents: [
      plannerRuntime(),
      runtime({
        petId: 'worker-a',
        name: 'Worker A',
        reply: 'a done',
        status: 'active',
        onInvoke: () => {
          events.push('worker-a');
        },
      }),
      runtime({
        petId: 'worker-b',
        name: 'Worker B',
        reply: 'b done',
        onInvoke: () => {
          events.push('worker-b');
        },
      }),
    ],
  });

  await submitWithPlannerStub(orchestrator, {
    userRequest: 'fifo head blocked',
    turnId: 'run-fifo-head-blocked',
    conversationId: 'conv-fifo-head-blocked',
    plan: {
      tasks: [
        { petId: 'worker-a', goal: 'first work', acceptanceCriteria: [] },
        { petId: 'worker-b', goal: 'second work', acceptanceCriteria: [] },
      ],
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, []);

  const run = orchestrator.getRun('run-fifo-head-blocked');
  assert.equal(run?.status, 'blocked');
  assert.equal(run?.tasks[0].status, 'queued');
  assert.equal(run?.tasks[1].status, 'queued');
});

test('studio runner waits for previous dependency before dispatching dependent task', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-fifo-deps-');
  const events: string[] = [];
  let releaseFirstWorker!: () => void;
  let markFirstWorkerStarted!: () => void;
  let markSecondWorkerStarted!: () => void;
  const firstWorkerStarted = new Promise<void>((resolve) => {
    markFirstWorkerStarted = resolve;
  });
  const secondWorkerStarted = new Promise<void>((resolve) => {
    markSecondWorkerStarted = resolve;
  });
  const firstWorkerGate = new Promise<void>((resolve) => {
    releaseFirstWorker = resolve;
  });
  let secondStarted = false;

  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    wikiBaseDir,
    plannerPetId: 'worker-a',
    agents: [
      plannerRuntime(),
      runtime({
        petId: 'worker-a',
        name: 'Worker A',
        reply: 'a done',
        onInvoke: async (input) => {
          events.push(`worker-a:${input.brief}`);
          markFirstWorkerStarted();
          await firstWorkerGate;
        },
      }),
      runtime({
        petId: 'worker-b',
        name: 'Worker B',
        reply: 'b done',
        onInvoke: (input) => {
          secondStarted = true;
          events.push(`worker-b:${input.brief}`);
          markSecondWorkerStarted();
        },
      }),
    ],
  });

  await submitWithPlannerStub(orchestrator, {
    userRequest: 'dependent work',
    turnId: 'run-fifo-deps',
    conversationId: 'conv-fifo-deps',
    plan: {
      tasks: [
        { petId: 'worker-a', goal: 'first work', acceptanceCriteria: [] },
        { petId: 'worker-b', goal: 'second work', acceptanceCriteria: [], deps: ['previous'] },
      ],
    },
  });

  await firstWorkerStarted;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(secondStarted, false);
  assert.deepEqual(events, ['worker-a:first work']);

  releaseFirstWorker();
  await secondWorkerStarted;
  const result = await orchestrator.waitForRun('run-fifo-deps');
  assert.equal(result.outcome.outcome, 'done');
  assert.deepEqual(events, ['worker-a:first work', 'worker-b:second work']);
});

test('studio run snapshot exposes task queue items and final pet run identity', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-task-snapshot-');
  let releaseWorker!: () => void;
  let markWorkerStarted!: () => void;
  const workerStarted = new Promise<void>((resolve) => {
    markWorkerStarted = resolve;
  });
  const workerGate = new Promise<void>((resolve) => {
    releaseWorker = resolve;
  });

  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    wikiBaseDir,
    plannerPetId: 'worker',
    agents: [
      plannerRuntime(),
      runtime({
        petId: 'worker',
        name: 'Worker',
        reply: 'snapshot done',
        onInvoke: async () => {
          markWorkerStarted();
          await workerGate;
        },
      }),
    ],
  });

  await submitWithPlannerStub(orchestrator, {
    userRequest: 'snapshot task',
    turnId: 'run-task-snapshot',
    conversationId: 'conv-task-snapshot',
    plan: {
      tasks: [
        { petId: 'worker', goal: 'snapshot work', acceptanceCriteria: ['done'] },
      ],
    },
  });

  await workerStarted;
  const running = orchestrator.getRun('run-task-snapshot');
  assert.equal(running?.tasks.length, 1);
  assert.equal(running?.tasks[0].status, 'running');
  assert.equal(running?.tasks[0].brief, 'snapshot work');
  assert.deepEqual(running?.tasks[0].deps, []);
  assert.match(running?.tasks[0].petRunId ?? '', /^[a-f0-9]{8}$/);
  assert.equal(running?.finalTaskIndex, undefined);
  assert.equal(running?.finalPetRunId, undefined);

  releaseWorker();
  const result = await orchestrator.waitForRun('run-task-snapshot');
  assert.equal(result.outcome.outcome, 'done');

  const done = orchestrator.getRun('run-task-snapshot');
  assert.equal(done?.status, 'done');
  assert.equal(done?.tasks[0].status, 'done');
  assert.equal(done?.finalTaskIndex, 0);
  assert.equal(done?.finalPetRunId, done?.tasks[0].petRunId);
  assert.equal(result.snapshot.finalPetRunId, done?.finalPetRunId);
  if (result.outcome.outcome === 'done') {
    assert.equal(result.outcome.finalTaskIndex, 0);
    assert.equal(result.outcome.finalPetRunId, done?.finalPetRunId);
  }
});

test('studio submitRequest accepts immediately and exposes run state through getRun and subscriptions', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-submit-');
  let releasePlanner!: () => void;
  let markPlannerStarted!: () => void;
  const plannerStarted = new Promise<void>((resolve) => {
    markPlannerStarted = resolve;
  });
  const plannerGate = new Promise<void>((resolve) => {
    releasePlanner = resolve;
  });
  const workerBriefs: string[] = [];

  const planner: PetAgentRuntime = {
    descriptor: () => ({
      petId: 'planner',
      userId: 'user-1',
      name: 'Planner',
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
      markPlannerStarted();
      await plannerGate;
      const planCap = (input.extraCapabilities ?? []).find(
        (cap: AgentCapability) => cap.name === 'studio_plan',
      );
      assert.ok(planCap, 'planner should receive studio_plan capability');
      const enqueueTool = findInjectedToolkitTool(input, 'studio_plan', 'enqueue_tasks');
      assert.ok(enqueueTool, 'enqueue_tasks tool should be available');
      await enqueueTool!.invoke({
        tasks: [
          { petId: 'worker', brief: 'queued work', acceptanceCriteria: [] },
        ],
      });
      return { reply: 'planned queued work' };
    },
  };

  const orchestrator = createStudioOrchestrator({
    curator: recordingCurator(),
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    wikiBaseDir,
    plannerPetId: 'planner',
    agents: [
      planner,
      runtime({
        petId: 'worker',
        name: 'Worker',
        reply: 'worker done',
        onInvoke: (input) => {
          workerBriefs.push(input.brief);
        },
      }),
    ],
  });

  const runEvents: StudioRunEvent[] = [];
  let markFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    markFinished = resolve;
  });
  const unsubscribe = orchestrator.subscribe((event) => {
    runEvents.push(event);
    if (
      event.runId === 'run-submit'
      && event.type === 'run_changed'
      && event.status === 'done'
    ) {
      markFinished();
    }
  });

  const accepted = await orchestrator.submitRequest({
    userRequest: 'submit this',
    turnId: 'run-submit',
    conversationId: 'conv-submit',
  });

  assert.deepEqual(accepted, { runId: 'run-submit', status: 'accepted' });
  await plannerStarted;
  assert.equal(orchestrator.getRun('run-submit')?.status, 'planning');
  assert.deepEqual(workerBriefs, []);

  releasePlanner();
  await finished;
  unsubscribe();

  const run = orchestrator.getRun('run-submit');
  assert.equal(run?.status, 'done');
  assert.equal(run?.tasks.length, 1);
  assert.equal(run?.tasks[0].petId, 'worker');
  assert.equal(run?.tasks[0].brief, 'queued work');
  assert.equal(run?.tasks[0].status, 'done');
  assert.equal(run?.finalPetRunId, run?.tasks[0].petRunId);
  assert.deepEqual(workerBriefs, ['queued work']);
  const runEventTypes = runEvents
    .filter((event) => event.runId === 'run-submit')
    .map((event) => event.type);
  assert.deepEqual(
    runEventTypes,
    [
      'run_changed',
      'run_changed',
      'run_changed',
      'run_changed',
      'run_changed',
      'wiki_changed',
      'run_changed',
    ],
  );
  const finalRunEvent = runEvents
    .filter((event): event is Extract<StudioRunEvent, { type: 'run_changed' }> => (
      event.runId === 'run-submit'
      && event.type === 'run_changed'
    ))
    .at(-1);
  assert.equal(finalRunEvent?.status, 'done');
  assert.equal(finalRunEvent?.snapshot.tasks.length, 1);
  assert.equal(finalRunEvent?.snapshot.finalPetRunId, run?.finalPetRunId);
  assert.deepEqual(
    runEvents
      .filter((event): event is Extract<StudioRunEvent, { type: 'wiki_changed' }> => (
        event.runId === 'run-submit'
        && event.type === 'wiki_changed'
      ))
      .flatMap((event) => event.changedPaths)
      .sort(),
    ['index.md', `sources/${run?.finalPetRunId}-worker.md`].sort(),
  );
});

test('studio submitRequest and subscribe expose the canonical async run API', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-submit-');
  const events: StudioRunEvent[] = [];

  const orchestrator = createStudioOrchestrator({
    curator: recordingCurator(),
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    wikiBaseDir,
    plannerPetId: 'worker',
    agents: [
      plannerRuntime(),
      runtime({ petId: 'worker', name: 'Worker', reply: 'submitted done' }),
    ],
  });

  const unsubscribe = orchestrator.subscribe((event) => {
    events.push(event);
  });
  const accepted = await submitWithPlannerStub(orchestrator, {
    userRequest: 'submit request',
    turnId: 'run-submit',
    conversationId: 'conv-submit',
    plan: {
      tasks: [
        { petId: 'worker', goal: 'submitted work', acceptanceCriteria: [] },
      ],
    },
  });

  assert.deepEqual(accepted, { runId: 'run-submit', status: 'accepted' });
  const result = await orchestrator.waitForRun('run-submit');
  unsubscribe();

  assert.equal(result.outcome.outcome, 'done');
  assert.equal(orchestrator.getRun('run-submit')?.status, 'done');
  assert.ok(events.some((event) => event.type === 'run_changed' && event.status === 'done'));
  assert.ok(events.some((event) => event.type === 'wiki_changed'));
});

test('studio orchestrator persists run snapshots to the configured run queue store', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-run-store-save-');
  const runQueueStore = new InMemoryStudioRunQueueStore();
  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    plannerPetId: 'worker',
    agents: [
      plannerRuntime(),
      runtime({ petId: 'worker', name: 'Worker', reply: 'stored result' }),
    ],
    wikiBaseDir,
    runQueueStore,
  });

  await runStudio(orchestrator, {
    userRequest: 'persist me',
    turnId: 'run-store-save',
    conversationId: 'conv-store-save',
    plan: {
      tasks: [
        {
          petId: 'worker',
          goal: 'store task',
          acceptanceCriteria: [],
        },
      ],
    },
  });

  const saved = runQueueStore.get('run-store-save');
  assert.equal(saved?.status, 'done');
  assert.equal(saved?.finalPetRunId, saved?.tasks[0]?.petRunId);
  assert.equal(saved?.tasks[0]?.status, 'done');
});

test('studio orchestrator restores queued tasks from run queue store without rerunning planner', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-run-store-restore-');
  const runQueueStore = new InMemoryStudioRunQueueStore();
  runQueueStore.save({
    runId: 'run-store-restore',
    conversationId: 'conv-store-restore',
    userRequest: 'restore queued work',
    status: 'running',
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:01.000Z',
    tasks: [
      {
        runId: 'run-store-restore',
        conversationId: 'conv-store-restore',
        taskIndex: 0,
        petId: 'worker',
        brief: 'restored task',
        acceptanceCriteria: [],
        deps: [],
        status: 'queued',
        enqueuedAt: '2026-06-20T00:00:01.000Z',
      },
    ],
  });

  let plannerInvocations = 0;
  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    plannerPetId: 'planner',
    agents: [
      runtime({
        petId: 'planner',
        name: 'Planner',
        reply: 'should not run',
        onInvoke: () => {
          plannerInvocations += 1;
        },
      }),
      runtime({ petId: 'worker', name: 'Worker', reply: 'restored result' }),
    ],
    wikiBaseDir,
    runQueueStore,
  });

  const result = await orchestrator.waitForRun('run-store-restore');

  assert.equal(plannerInvocations, 0);
  assert.equal(result.outcome.outcome, 'done');
  assert.equal(result.outcome.reply, 'restored result');
  assert.equal(runQueueStore.get('run-store-restore')?.status, 'done');
});

test('studio orchestrator can skip store recovery for per-turn fresh hosts', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-run-store-no-restore-');
  const runQueueStore = new InMemoryStudioRunQueueStore();
  runQueueStore.save({
    runId: 'run-store-no-restore',
    conversationId: 'conv-store-no-restore',
    userRequest: 'must not be restored',
    status: 'running',
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:01.000Z',
    tasks: [
      {
        runId: 'run-store-no-restore',
        conversationId: 'conv-store-no-restore',
        taskIndex: 0,
        petId: 'worker',
        brief: 'do not dispatch',
        acceptanceCriteria: [],
        deps: [],
        status: 'queued',
        enqueuedAt: '2026-06-20T00:00:01.000Z',
      },
    ],
  });

  let workerInvocations = 0;
  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    plannerPetId: 'planner',
    agents: [
      plannerRuntime(),
      runtime({
        petId: 'worker',
        name: 'Worker',
        reply: 'should not run',
        onInvoke: () => {
          workerInvocations += 1;
        },
      }),
    ],
    wikiBaseDir,
    runQueueStore,
    restoreOpenRuns: false,
  });

  assert.equal(orchestrator.getRun('run-store-no-restore'), null);
  assert.equal(workerInvocations, 0);
});

test('studio orchestrator finalizes recovered open run when all tasks are already terminal', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-run-store-terminal-');
  const runQueueStore = new InMemoryStudioRunQueueStore();
  runQueueStore.save({
    runId: 'run-store-terminal',
    conversationId: 'conv-store-terminal',
    userRequest: 'already complete',
    status: 'running',
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:01.000Z',
    tasks: [
      {
        runId: 'run-store-terminal',
        conversationId: 'conv-store-terminal',
        taskIndex: 0,
        petId: 'worker',
        brief: 'already done',
        acceptanceCriteria: [],
        deps: [],
        status: 'done',
        petRunId: 'pet-run-restored',
        enqueuedAt: '2026-06-20T00:00:01.000Z',
        startedAt: '2026-06-20T00:00:02.000Z',
        finishedAt: '2026-06-20T00:00:03.000Z',
      },
    ],
  });

  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    plannerPetId: 'planner',
    agents: [
      plannerRuntime(),
      runtime({ petId: 'worker', name: 'Worker', reply: 'should not run' }),
    ],
    wikiBaseDir,
    runQueueStore,
  });

  const result = await orchestrator.waitForRun('run-store-terminal');

  assert.equal(result.outcome.outcome, 'done');
  assert.equal(result.outcome.finalPetRunId, 'pet-run-restored');
  assert.equal(result.outcome.reply, '');
  assert.equal(runQueueStore.get('run-store-terminal')?.status, 'done');
});

test('studio cancelRun aborts planning and prevents tasks from being queued afterwards', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-cancel-api-');
  let releasePlanner!: () => void;
  let markPlannerStarted!: () => void;
  const plannerStarted = new Promise<void>((resolve) => {
    markPlannerStarted = resolve;
  });
  const plannerGate = new Promise<void>((resolve) => {
    releasePlanner = resolve;
  });
  let workerInvoked = false;

  const planner: PetAgentRuntime = {
    descriptor: () => ({
      petId: 'planner',
      userId: 'user-1',
      name: 'Planner',
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
      markPlannerStarted();
      await plannerGate;
      const planCap = (input.extraCapabilities ?? []).find(
        (cap: AgentCapability) => cap.name === 'studio_plan',
      );
      assert.ok(planCap, 'planner should receive studio_plan capability');
      const enqueueTool = findInjectedToolkitTool(input, 'studio_plan', 'enqueue_tasks');
      assert.ok(enqueueTool, 'enqueue_tasks tool should be available');
      await enqueueTool!.invoke({
        tasks: [
          { petId: 'worker', brief: 'work after cancel', acceptanceCriteria: [] },
        ],
      });
      return { reply: 'planned after cancel' };
    },
  };

  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    wikiBaseDir,
    plannerPetId: 'planner',
    agents: [
      planner,
      runtime({
        petId: 'worker',
        name: 'Worker',
        reply: 'should not run',
        onInvoke: () => {
          workerInvoked = true;
        },
      }),
    ],
  });

  await orchestrator.submitRequest({
    userRequest: 'cancel while planning',
    turnId: 'run-cancel-api',
    conversationId: 'conv-cancel-api',
  });
  await plannerStarted;
  await orchestrator.cancelRun('run-cancel-api');
  releasePlanner();

  const result = await orchestrator.waitForRun('run-cancel-api');
  assert.equal(result.outcome.outcome, 'stopped');
  assert.equal(orchestrator.getRun('run-cancel-api')?.status, 'cancelled');
  assert.deepEqual(orchestrator.getRun('run-cancel-api')?.tasks, []);
  assert.equal(workerInvoked, false);
});

test('studio cancelRun marks running task cancelled in the immediate snapshot', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-cancel-running-');
  let releaseWorker!: () => void;
  let markWorkerStarted!: () => void;
  const workerStarted = new Promise<void>((resolve) => {
    markWorkerStarted = resolve;
  });
  const workerGate = new Promise<void>((resolve) => {
    releaseWorker = resolve;
  });

  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    wikiBaseDir,
    plannerPetId: 'planner',
    agents: [
      plannerRuntime(),
      runtime({
        petId: 'worker',
        name: 'Worker',
        reply: 'finished after cancel',
        onInvoke: async () => {
          markWorkerStarted();
          await workerGate;
        },
      }),
    ],
  });

  await submitWithPlannerStub(orchestrator, {
    userRequest: 'cancel running worker',
    turnId: 'run-cancel-running',
    conversationId: 'conv-cancel-running',
    plan: {
      tasks: [
        { petId: 'worker', goal: 'hold until cancelled', acceptanceCriteria: [] },
      ],
    },
  });
  await workerStarted;
  assert.equal(orchestrator.getRun('run-cancel-running')?.tasks[0]?.status, 'running');

  await orchestrator.cancelRun('run-cancel-running');

  const cancelledSnapshot = orchestrator.getRun('run-cancel-running');
  assert.equal(cancelledSnapshot?.status, 'cancelled');
  assert.equal(cancelledSnapshot?.tasks[0]?.status, 'cancelled');

  releaseWorker();
  const result = await orchestrator.waitForRun('run-cancel-running');
  assert.equal(result.outcome.outcome, 'stopped');
  assert.equal(orchestrator.getRun('run-cancel-running')?.tasks[0]?.status, 'cancelled');
});
