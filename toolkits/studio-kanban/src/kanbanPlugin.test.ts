import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createStudio } from '@pinpawo/studio';
import type {
  PetAgentRuntime,
  PetAgentRuntimeInvokeInput,
  StudioEvent,
} from '@pinpawo/studio';
import type { NamedStructuredTool } from '@pinpawo/pet-agent';

import { createKanbanPlugin } from './kanbanPlugin';
import { KanbanBoard } from './kanbanBoard';

/**
 * 一个只会"收到任务 → 调工具"的假 pet。
 *
 * 它模拟真实链路的关键一环:pet 通过 **toolkit** 与看板交互,
 * 从不直接与 studio 通信。
 */
function pet(options: {
  petId: string;
  onInvoke?: (input: PetAgentRuntimeInvokeInput, tools: KanbanTools) => Promise<void> | void;
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
      await options.onInvoke?.(input, options.tools());
      return { status: 'completed', reply: 'ok' };
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
