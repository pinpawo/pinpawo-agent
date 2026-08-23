import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createStudio } from '@pinpawo/studio';
import type {
  PetAgentRuntime,
  PetAgentRuntimeInvokeInput,
  PetAgentRuntimeInvokeResult,
  StudioEvent,
} from '@pinpawo/studio';
import type { NamedStructuredTool } from '@pinpawo/pet-agent';

import { createKanbanPlugin } from './kanbanPlugin';
import { KanbanBoard, type KanbanBoardSnapshot } from './kanbanBoard';
import type { KanbanStateStore } from './kanbanStateStore';

/**
 * 一个只会"收到任务 → 调工具"的假 pet。
 *
 * 它模拟真实链路的关键一环:pet 通过 **toolkit** 与看板交互,
 * 从不直接与 studio 通信。
 */
function pet(options: {
  petId: string;
  onInvoke?: (
    input: PetAgentRuntimeInvokeInput,
    tools: KanbanTools,
  ) => Promise<PetAgentRuntimeInvokeResult | void> | PetAgentRuntimeInvokeResult | void;
  tools: () => KanbanTools;
}): PetAgentRuntime {
  return {
    // 假 pet 一跑完门就开 —— 看板用例不涉及卡住的场景。
    gate: () => 'open',
    onGateChange: () => () => {},
    descriptor: () => ({
      petId: options.petId,
      userId: null,
      name: options.petId,
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
      const result = await options.onInvoke?.(input, options.tools());
      return result ?? { status: 'completed', reply: 'ok' };
    },
  };
}

type KanbanTools = Record<string, NamedStructuredTool>;

function pluginTools(plugin: ReturnType<typeof createKanbanPlugin>) {
  const toolkit = plugin.toolkits[0];
  assert.ok(toolkit, 'kanban Plugin must define its Agent Toolkit');
  return Object.fromEntries(
    toolkit.tools.map(({ tool }) => [tool.name, tool]),
  ) as KanbanTools;
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

test('a full round: entry pet plans, kanban dispatches, worker completes', async () => {
  // 这是契约的端到端验证:studio 不理解任何看板概念,pet 不知道自己在
  // 驱动一块看板,两者只通过 dispatch / toolkit 相连。
  const plugin = createKanbanPlugin();
  const events: StudioEvent[] = [];
  let writerBrief = '';

  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'planner',
    pets: [
      pet({
        petId: 'planner',
        tools: () => pluginTools(plugin),
        onInvoke: async (_input, tools) => {
          // planner 拆解出一个任务 —— 它只知道"新增任务"，不知道看板。
          await tools.kanban_task_add!.invoke({ petId: 'writer', brief: '写稿' });
        },
      }),
      pet({
        petId: 'writer',
        tools: () => ({}),
        onInvoke: async (input) => {
          writerBrief = input.input.kind === 'request' ? input.input.request : '';
          const taskId = /Kanban taskId: ([^\s]+)/.exec(writerBrief)?.[1];
          assert.ok(taskId, 'Kanban Plugin must put its taskId in the dispatched request');
          const tools = pluginTools(plugin);
          await tools.kanban_task_complete!.invoke(
            { taskId, result: '稿子写完了' },
          );
        },
      }),
    ],
    plugins: [plugin],
  });

  studio.subscribe((event) => { events.push(event); });

  await studio.dispatch({
    petId: studio.entryPetId,
    input: { kind: 'request', request: '写一篇关于 X 的稿子' },
  });
  await flush();

  // Plugin 派发自己的领域 taskId 和原始 brief，不需要 runtime identity 帮它关联。
  assert.match(writerBrief, /Kanban taskId:/);
  assert.match(writerBrief, /写稿/);

  const tasks = plugin.board.list();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.status, 'done');
  assert.equal(tasks[0]?.note, '稿子写完了');

  // 状态变化经插件转成 event 广播出去,studio 只转发不解释。
  assert.ok(events.some((event) => event.type === 'task.done'));
  assert.ok(events.every((event) => event.source === 'kanban'));
});

test('a dependent task waits until its dependency is done', async () => {
  const board = new KanbanBoard();
  const plugin = createKanbanPlugin({ board });
  const dispatched: string[] = [];

  const first = board.add({ petId: 'worker', brief: 'first' });
  board.add({ petId: 'worker', brief: 'second', deps: [first.taskId] });

  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [pet({
      petId: 'worker',
      tools: () => ({}),
      onInvoke: async (input) => {
        if (input.input.kind === 'request') dispatched.push(input.input.request);
      },
    })],
    plugins: [plugin],
  });

  // 插件启动时还没有状态变化,主动触发一次即可开始。
  board.add({ petId: 'worker', brief: 'kick' });
  await flush();

  // 依赖未满足的 second 不该被派发。
  assert.ok(dispatched.some((request) => request.includes('first')));
  assert.ok(!dispatched.some((request) => request.includes('second')));

  board.complete(first.taskId, 'done');
  await flush();

  assert.ok(dispatched.some((request) => request.includes('second')));
  await studio.shutdown();
});

test('a blocked task neither retries nor blocks other ready work', async () => {
  // 自动重试已退役:卡住就留在看板上等人。而它不该连累别的任务。
  const board = new KanbanBoard();
  const plugin = createKanbanPlugin({ board });
  const dispatched: string[] = [];

  const stuck = board.add({ petId: 'worker', brief: 'stuck' });
  board.block(stuck.taskId, 'needs a decision');
  board.add({ petId: 'worker', brief: 'independent' });

  await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [pet({
      petId: 'worker',
      tools: () => ({}),
      onInvoke: async (input) => {
        if (input.input.kind === 'request') dispatched.push(input.input.request);
      },
    })],
    plugins: [plugin],
  });

  board.add({ petId: 'worker', brief: 'kick' });
  await flush();

  assert.ok(
    dispatched.some((request) => request.includes('independent')),
    'a blocked task must not stall ready work',
  );
  assert.equal(dispatched.filter((request) => request.includes('stuck')).length, 0);
  assert.equal(board.get(stuck.taskId)?.status, 'blocked');
});

test('restart marks in-flight tasks blocked rather than silently requeuing them', async () => {
  // 进程已经不在了,doing 不可能还在跑。恢复成 blocked 而不是 todo ——
  // 重来与否是人的判断。
  const source = new KanbanBoard();
  const task = source.add({ petId: 'worker', brief: 'interrupted' });
  source.markDispatched(task.taskId);

  const restored = new KanbanBoard();
  restored.restore(source.snapshot());

  assert.equal(restored.get(task.taskId)?.status, 'blocked');
  assert.match(restored.get(task.taskId)?.note ?? '', /interrupted by restart/);
});

test('pending interrupt makes a task visible as waiting and the resumed tool can finish it', async () => {
  const board = new KanbanBoard();
  const task = board.add({ petId: 'worker', brief: 'needs approval' });
  const plugin = createKanbanPlugin({ board });
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [pet({
      petId: 'worker',
      tools: () => pluginTools(plugin),
      onInvoke: () => ({
        status: 'pending_interrupt',
        pendingInterrupt: {
          interruptId: 'interrupt-1',
          payload: {
            kind: 'human_review',
            interactions: [{
              interactionId: 'interaction-1',
              schemaVersion: 2,
              view: { kind: 'plain', body: 'Approve?' },
              options: [{ id: 'approve', label: 'Approve', batchSubmission: 'immediate' }],
            }],
          },
        },
      }),
    })],
    plugins: [plugin],
  });

  await flush();
  assert.equal(board.get(task.taskId)?.status, 'waiting');

  await pluginTools(plugin).kanban_task_complete!.invoke({
    taskId: task.taskId,
    result: 'continued after approval',
  });
  assert.equal(board.get(task.taskId)?.status, 'done');
  await studio.shutdown();
});

test('an invocation that returns without reporting an outcome does not leave doing behind', async () => {
  const board = new KanbanBoard();
  const task = board.add({ petId: 'worker', brief: 'must report outcome' });
  const plugin = createKanbanPlugin({ board });
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [pet({ petId: 'worker', tools: () => ({}) })],
    plugins: [plugin],
  });

  await flush();
  assert.equal(board.get(task.taskId)?.status, 'blocked');
  assert.match(board.get(task.taskId)?.note ?? '', /without reporting/);
  await studio.shutdown();
});

test('failed and cancelled invocations become explicit blocked tasks', async (t) => {
  await t.test('failed', async () => {
    const board = new KanbanBoard();
    const task = board.add({ petId: 'worker', brief: 'will fail' });
    const plugin = createKanbanPlugin({ board });
    const studio = await createStudio({
      studioId: 'failed-studio',
      entryPetId: 'worker',
      pets: [pet({
        petId: 'worker',
        tools: () => ({}),
        onInvoke: () => { throw new Error('worker exploded'); },
      })],
      plugins: [plugin],
    });

    await flush();
    assert.equal(board.get(task.taskId)?.status, 'blocked');
    assert.match(board.get(task.taskId)?.note ?? '', /worker exploded/);
    await studio.shutdown();
  });

  await t.test('cancelled', async () => {
    const board = new KanbanBoard();
    const task = board.add({ petId: 'worker', brief: 'will be cancelled' });
    const plugin = createKanbanPlugin({ board });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const studio = await createStudio({
      studioId: 'cancelled-studio',
      entryPetId: 'worker',
      pets: [pet({
        petId: 'worker',
        tools: () => ({}),
        onInvoke: (input) => new Promise((_resolve, reject) => {
          markStarted?.();
          input.signal?.addEventListener('abort', () => reject(input.signal?.reason), { once: true });
        }),
      })],
      plugins: [plugin],
    });

    await started;
    await studio.shutdown();
    assert.equal(board.get(task.taskId)?.status, 'blocked');
    assert.match(board.get(task.taskId)?.note ?? '', /cancelled/);
  });
});

test('the doing snapshot is durable before Kanban dispatches external work', async () => {
  const board = new KanbanBoard();
  const task = board.add({ petId: 'worker', brief: 'persist first' });
  let durable: KanbanBoardSnapshot = { tasks: [] };
  const store: KanbanStateStore = {
    load: async () => null,
    save: async (snapshot) => {
      durable = structuredClone(snapshot);
    },
  };
  const plugin = createKanbanPlugin({ board, stateStore: store });
  let durableStatusAtInvoke: string | undefined;
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [pet({
      petId: 'worker',
      tools: () => pluginTools(plugin),
      onInvoke: async (_input, tools) => {
        durableStatusAtInvoke = durable.tasks[0]?.status;
        await tools.kanban_task_complete!.invoke({ taskId: task.taskId, result: 'done' });
      },
    })],
    plugins: [plugin],
  });

  await flush();
  assert.equal(durableStatusAtInvoke, 'doing');
  assert.equal(durable.tasks[0]?.status, 'done');
  await studio.shutdown();
});

test('Plugin startup restores doing as blocked without redispatching it', async () => {
  const source = new KanbanBoard();
  const task = source.add({ petId: 'worker', brief: 'uncertain external effect' });
  source.markDispatched(task.taskId);
  let durable = source.snapshot();
  const store: KanbanStateStore = {
    load: async () => structuredClone(durable),
    save: async (snapshot) => {
      durable = structuredClone(snapshot);
    },
  };
  const plugin = createKanbanPlugin({ stateStore: store });
  let invocationCount = 0;
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [pet({
      petId: 'worker',
      tools: () => ({}),
      onInvoke: () => { invocationCount += 1; },
    })],
    plugins: [plugin],
  });

  await flush();
  assert.equal(invocationCount, 0);
  assert.equal(plugin.board.get(task.taskId)?.status, 'blocked');
  assert.equal(durable.tasks[0]?.status, 'blocked');
  await studio.shutdown();
});

test('Plugin serializes durable snapshots and flushes the latest state on stop', async () => {
  let activeSaves = 0;
  let maxActiveSaves = 0;
  let durable: KanbanBoardSnapshot = { tasks: [] };
  const store: KanbanStateStore = {
    load: async () => null,
    save: async (snapshot) => {
      activeSaves += 1;
      maxActiveSaves = Math.max(maxActiveSaves, activeSaves);
      await new Promise((resolve) => setTimeout(resolve, 2));
      durable = structuredClone(snapshot);
      activeSaves -= 1;
    },
  };
  const plugin = createKanbanPlugin({ stateStore: store });
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [pet({ petId: 'worker', tools: () => ({}) })],
    plugins: [plugin],
  });

  plugin.board.add({ petId: 'worker', brief: 'one', deps: ['external'] });
  plugin.board.add({ petId: 'worker', brief: 'two', deps: ['external'] });
  plugin.board.add({ petId: 'worker', brief: 'three', deps: ['external'] });
  await studio.shutdown();

  assert.equal(maxActiveSaves, 1);
  assert.equal(durable.tasks.length, 3);
});

test('a state save failure blocks the task before dispatch', async () => {
  const board = new KanbanBoard();
  const task = board.add({ petId: 'worker', brief: 'must not escape durability' });
  let saveCount = 0;
  const store: KanbanStateStore = {
    load: async () => null,
    save: async () => {
      saveCount += 1;
      if (saveCount === 2) throw new Error('disk unavailable');
    },
  };
  const plugin = createKanbanPlugin({ board, stateStore: store });
  let invocationCount = 0;
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [pet({
      petId: 'worker',
      tools: () => ({}),
      onInvoke: () => { invocationCount += 1; },
    })],
    plugins: [plugin],
  });

  await flush();
  assert.equal(invocationCount, 0);
  assert.equal(board.get(task.taskId)?.status, 'blocked');
  assert.match(board.get(task.taskId)?.note ?? '', /persistence failed.*disk unavailable/i);
  await studio.shutdown();
});

test('tools report plainly when taskId does not identify a doing task', async () => {
  const plugin = createKanbanPlugin();
  const tools = pluginTools(plugin);

  assert.match(
    await tools.kanban_task_complete!.invoke(
      { taskId: 'missing', result: 'x' },
    ) as string,
    /unknown Kanban taskId/,
  );
});
