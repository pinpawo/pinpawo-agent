import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStudioOrchestrator } from './createStudioOrchestrator';
import type {
  PetAgentRuntime,
  PetAgentRuntimeDescriptor,
  PetAgentRuntimeInvokeInput,
  PetAgentRuntimeInvokeResult,
} from './types';
import type { AgentCapability } from '../../types/capability';
import type { StudioTaskPlan, StudioTurnEvent } from './types';

function runtime(params: {
  petId: string;
  name: string;
  reply: string;
  status?: PetAgentRuntimeDescriptor['status'];
  onInvoke?: (input: PetAgentRuntimeInvokeInput) => void;
}): PetAgentRuntime {
  const descriptor: PetAgentRuntimeDescriptor = {
    petId: params.petId,
    userId: 'user-1',
    name: params.name,
    personality: null,
    stage: null,
    species: null,
    role: null,
    serviceSummary: null,
    startupMode: 'standby',
    status: params.status ?? 'standby',
    capabilities: [],
  };

  return {
    descriptor: () => descriptor,
    invoke: async (input: PetAgentRuntimeInvokeInput): Promise<PetAgentRuntimeInvokeResult> => {
      params.onInvoke?.(input);
      return { reply: params.reply };
    },
  };
}

async function makeWikiTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
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
      runtime({ petId: 'script', name: 'Script Pet', reply: 'script done' }),
      runtime({ petId: 'audio', name: 'Audio Pet', reply: 'audio done' }),
    ],
  });

  const context = orchestrator.context();
  assert.equal(context.studioId, 'studio-1');
  assert.equal(context.defaultPetId, 'script');
  assert.deepEqual(context.agents.map((agent) => agent.petId), ['script', 'audio']);
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

  const result = await orchestrator.invoke({
    userRequest: '帮我开始写视频脚本',
    turnId: 'turn-1',
    conversationId: 'conv-1',
    plan: {
      tasks: [
        {
          petId: 'script',
          goal: '写视频脚本结构',
          acceptanceCriteria: [],
          status: 'pending',
          retryCount: 0,
        },
        {
          petId: 'audio',
          goal: '评估尾音频需求,整合输出',
          acceptanceCriteria: [],
          status: 'pending',
          retryCount: 0,
        },
      ],
    },
  });

  assert.equal(result.turnId, 'turn-1');
  assert.equal(result.outcome.outcome, 'done');
  if (result.outcome.outcome === 'done') {
    assert.equal(result.outcome.reply, 'audio done');
  }
  assert.equal(result.state.dispatches.length, 2);
  assert.deepEqual(
    result.state.dispatches.map((d) => d.status),
    ['finished', 'finished'],
  );
  assert.deepEqual(briefs, ['写视频脚本结构', '评估尾音频需求,整合输出']);
  assert.deepEqual(workdirs, ['/tmp/pinpawo-studio-workdir', '/tmp/pinpawo-studio-workdir']);
  // 所有 dispatch 都拿到 wikiRoot
  assert.equal(wikiRoots.length, 2);
  for (const root of wikiRoots) {
    assert.ok(root, 'wikiRoot should be injected');
    assert.ok(root!.includes('conv-1'), 'wikiRoot should be namespaced by conversationId');
  }
  // 最终标定的就是末位 dispatch
  if (result.outcome.outcome === 'done') {
    assert.equal(
      result.outcome.finalDispatchId,
      result.state.dispatches[result.state.dispatches.length - 1].id,
    );
  }
});

test('studio orchestrator emits onTurnEvent lifecycle for happy path', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-turn-event-');
  const events: StudioTurnEvent[] = [];

  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    wikiBaseDir,
    plannerPetId: 'planner',
    agents: [
      runtime({ petId: 'script', name: 'Script Pet', reply: 'script done' }),
    ],
  });

  const result = await orchestrator.invoke({
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
          status: 'pending',
          retryCount: 0,
        },
      ],
    },
  });

  assert.equal(result.outcome.outcome, 'done');

  // 期待事件顺序:turn_started → plan_set → dispatch_started → task_status_changed(satisfied)
  // → wiki_updated → dispatch_finished → turn_finished
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    'turn_started',
    'plan_set',
    'dispatch_started',
    'task_status_changed',
    'wiki_updated',
    'dispatch_finished',
    'turn_finished',
  ]);

  const started = events[0] as Extract<StudioTurnEvent, { type: 'turn_started' }>;
  assert.equal(started.turnId, 'turn-evt-1');
  assert.equal(started.userRequest, '写脚本');

  const finished = events.at(-1) as Extract<StudioTurnEvent, { type: 'turn_finished' }>;
  assert.equal(finished.outcome, 'done');
  assert.ok(finished.finalDispatchId);

  const dispatchFinished = events.find((e) => e.type === 'dispatch_finished') as Extract<StudioTurnEvent, { type: 'dispatch_finished' }>;
  assert.equal(dispatchFinished.status, 'finished');
  assert.equal(dispatchFinished.resultText, 'script done');
});

test('studio orchestrator emits turn_started then turn_finished(stopped) when planner has no plan', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-no-plan-');
  const events: StudioTurnEvent[] = [];

  // 不传 explicit plan + 没注册 planner 之外的 agent + planner 返回空 reply → 期望 stopped
  // planner pet 返回空,没有 capability 被调用,obtainPlan 拿不到 plan
  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    wikiBaseDir,
    plannerPetId: 'planner',
    agents: [
      runtime({ petId: 'planner', name: 'Planner', reply: '' }),
    ],
  });

  await orchestrator.invoke({
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

test('studio orchestrator透传 onToolEvent to dispatched pet runtime', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-tool-event-');
  const captured: Array<unknown> = [];

  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    wikiBaseDir,
    plannerPetId: 'planner',
    agents: [
      runtime({
        petId: 'script',
        name: 'Script Pet',
        reply: 'script done',
        onInvoke: (input) => {
          captured.push(input.onToolEvent);
        },
      }),
    ],
  });

  const handler = () => {};
  await orchestrator.invoke({
    userRequest: '写脚本',
    conversationId: 'conv-tool-event',
    onToolEvent: handler,
    plan: {
      tasks: [
        {
          petId: 'script',
          goal: '写脚本结构',
          acceptanceCriteria: [],
          status: 'pending',
          retryCount: 0,
        },
      ],
    },
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0], handler, 'dispatched pet should receive the same onToolEvent');
});

test('wiki curator writes per-dispatch source file and updates index', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-wiki-');
  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    wikiBaseDir,
    plannerPetId: 'planner',
    agents: [
      runtime({ petId: 'script', name: 'Script Pet', reply: 'script outline content' }),
    ],
  });

  const result = await orchestrator.invoke({
    userRequest: '写脚本',
    conversationId: 'conv-wiki-1',
    plan: {
      tasks: [
        {
          petId: 'script',
          goal: '写视频脚本结构',
          acceptanceCriteria: [],
          status: 'pending',
          retryCount: 0,
        },
      ],
    },
  });

  assert.equal(result.outcome.outcome, 'done');
  const wikiRoot = result.state.wikiRoot;
  const dispatchId = result.state.dispatches[0].id;
  const sourcePath = path.join(wikiRoot, 'sources', `${dispatchId}-script.md`);
  const sourceContent = await fs.readFile(sourcePath, 'utf8');
  assert.match(sourceContent, /script outline content/);
  const indexContent = await fs.readFile(path.join(wikiRoot, 'index.md'), 'utf8');
  assert.match(indexContent, new RegExp(dispatchId));
});

test('studio orchestrator surfaces failed pet as task failed and stops when no result available', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-fail-');
  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    wikiBaseDir,
    plannerPetId: 'broken',
    maxRetryPerTask: 1,
    agents: [
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

  const result = await orchestrator.invoke({
    userRequest: '试试',
    conversationId: 'conv-fail-1',
    plan: {
      tasks: [
        {
          petId: 'broken',
          goal: '不可能完成的任务',
          acceptanceCriteria: [],
          status: 'pending',
          retryCount: 0,
        },
      ],
    },
  });

  assert.equal(result.outcome.outcome, 'stopped');
  assert.equal(result.state.plan?.tasks[0].status, 'failed');
});

test('studio invokes planner agent when no explicit plan, captures submitted plan and dispatches it', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-planner-');

  // 模拟 planner pet:当它被 invoke 时,模拟 LLM 调 submit_plan 工具
  // 把 plan 通过 extraCapabilities 的 plan capability 提交出来
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
      const runtime = await planCap!.createRuntime({} as never);
      const submitTool = runtime.toolsets
        ?.flatMap((toolset) => toolset.tools)
        .find((t) => t.name === 'submit_plan');
      assert.ok(submitTool, 'submit_plan tool should be available');
      // 模拟 LLM 调 tool 提交 plan
      await submitTool!.invoke({
        tasks: [
          { petId: 'worker', goal: 'do the work', acceptanceCriteria: ['done'] },
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
      runtime({ petId: 'worker', name: 'Worker', reply: 'worker done' }),
    ],
  });

  const result = await orchestrator.invoke({
    userRequest: '请帮我完成任务',
    conversationId: 'conv-planner-1',
  });

  // planner 被 invoke 一次
  assert.equal(plannerInvocations.length, 1);
  assert.equal(plannerInvocations[0].brief, '请帮我完成任务');
  assert.match(plannerInvocations[0].threadId ?? '', /planner$/);

  // plan 被捕获 + dispatch 顺利执行
  assert.equal(result.outcome.outcome, 'done');
  assert.equal(result.state.plan?.tasks.length, 1);
  assert.equal(result.state.plan?.tasks[0].petId, 'worker');
  assert.equal(result.state.dispatches.length, 1);
  assert.equal(result.state.dispatches[0].resultText, 'worker done');
  if (result.outcome.outcome === 'done') {
    assert.equal(result.outcome.reply, 'worker done');
  }
});

test('studio uses injected curator instead of skeleton default', async () => {
  const wikiBaseDir = await makeWikiTempDir('studio-curator-');
  const curatedDispatches: string[] = [];

  const orchestrator = createStudioOrchestrator({
    studioId: 'studio-1',
    ownerUserId: 'user-1',
    wikiBaseDir,
    plannerPetId: 'worker',
    curator: {
      curate: async ({ dispatch }) => {
        curatedDispatches.push(dispatch.id);
        return { changedPaths: [`custom/${dispatch.id}.md`] };
      },
    },
    agents: [
      runtime({ petId: 'worker', name: 'Worker', reply: 'done' }),
    ],
  });

  const result = await orchestrator.invoke({
    userRequest: '随便',
    conversationId: 'conv-curator-1',
    plan: {
      tasks: [
        {
          petId: 'worker',
          goal: '工作',
          acceptanceCriteria: [],
          status: 'pending',
          retryCount: 0,
        },
      ],
    },
  });

  assert.equal(result.outcome.outcome, 'done');
  assert.equal(curatedDispatches.length, 1);
  assert.equal(curatedDispatches[0], result.state.dispatches[0].id);
});

test('studio stops when planner did not submit a plan', async () => {
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

  const result = await orchestrator.invoke({
    userRequest: '帮我',
    conversationId: 'conv-planner-fail-1',
  });

  assert.equal(result.outcome.outcome, 'stopped');
  if (result.outcome.outcome === 'stopped') {
    assert.match(result.outcome.reason, /planner did not submit a plan/);
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

  await orchestrator.invoke({
    userRequest: '继续',
    conversationId: 'conv-thread-1',
    plan: {
      tasks: [
        {
          petId: 'script',
          goal: '走一棒',
          acceptanceCriteria: [],
          status: 'pending',
          retryCount: 0,
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
