/**
 * Kanban Plugin —— Studio 的第一个 layout Plugin。
 *
 * Plugin 定义供 Agent 使用的 Kanban Toolkit,并在 Studio 生命周期内负责
 * 依赖派发与事件通知。Plugin 本身不是 Toolkit。
 *
 * 闭环:pet 调工具 → 看板状态变 → 插件 dispatch 下一棒 / 发 event。
 * 全程 studio 不理解任何看板概念,pet 也不知道自己在驱动一块看板。
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type {
  AgentToolkit,
  NamedStructuredTool,
} from '@pinpawo/pet-agent';
import type {
  StudioDispatchResult,
  StudioPlugin,
  StudioPluginContext,
} from '@pinpawo/studio';

import { KanbanBoard, type KanbanTask } from './kanbanBoard';
import type { KanbanStateStore } from './kanbanStateStore';

export const KANBAN_TOOLKIT_NAME = 'kanban';

const TOOL_TITLES = ['查看任务', '新增任务', '完成任务', '阻塞任务'] as const;

function describeTask(task: KanbanTask): string {
  const deps = task.deps.length > 0 ? ` deps=[${task.deps.join(', ')}]` : '';
  const note = task.note ? ` note=${task.note}` : '';
  return `${task.taskId} [${task.status}] pet=${task.petId}${deps} ${task.brief}${note}`;
}

function buildTaskRequest(task: KanbanTask): string {
  return [
    `Kanban taskId: ${task.taskId}`,
    '',
    task.brief,
    '',
    'When reporting completion or a block, pass this taskId to the Kanban tool.',
  ].join('\n');
}

function buildTools(board: KanbanBoard): NamedStructuredTool[] {
  const canFinish = (task: KanbanTask) => (
    task.status === 'doing' || task.status === 'waiting'
  );
  const listTasks = tool(
    async () => {
      const tasks = board.list();
      return tasks.length === 0 ? '(no tasks yet)' : tasks.map(describeTask).join('\n');
    },
    {
      name: 'kanban_task_list',
      description: '列出当前所有任务及其状态、依赖与结果。',
      schema: z.object({}),
    },
  );

  const addTask = tool(
    async (input) => {
      const task = board.add({
        petId: input.petId,
        brief: input.brief,
        ...(input.dependsOn ? { deps: input.dependsOn } : {}),
      });
      return `added ${task.taskId}`;
    },
    {
      name: 'kanban_task_add',
      description:
        '新增一个任务并指派给某个 pet。用 dependsOn 声明它依赖哪些任务先完成;'
        + '依赖全部完成后该任务才会被派发。',
      schema: z.object({
        petId: z.string().describe('由哪个 pet 执行'),
        brief: z.string().describe('任务描述，接收方将以此为唯一输入'),
        dependsOn: z.array(z.string()).optional().describe('依赖的 taskId'),
      }),
    },
  );

  const completeTask = tool(
    async (input) => {
      const task = board.get(input.taskId);
      if (!task) return `unknown Kanban taskId "${input.taskId}"`;
      if (!canFinish(task)) {
        return `Kanban task "${input.taskId}" is ${task.status}, not active`;
      }
      board.complete(task.taskId, input.result);
      return `completed ${task.taskId}`;
    },
    {
      name: 'kanban_task_complete',
      description: '按 taskId 标记任务已完成，并附上结果供后续任务参考。',
      schema: z.object({
        taskId: z.string().describe('派发请求中给出的 Kanban taskId'),
        result: z.string().describe('完成结果或产出摘要'),
      }),
    },
  );

  const blockTask = tool(
    async (input) => {
      const task = board.get(input.taskId);
      if (!task) return `unknown Kanban taskId "${input.taskId}"`;
      if (!canFinish(task)) {
        return `Kanban task "${input.taskId}" is ${task.status}, not active`;
      }
      board.block(task.taskId, input.reason);
      return `blocked ${task.taskId}`;
    },
    {
      name: 'kanban_task_block',
      description:
        '按 taskId 标记无法完成的任务，并说明原因。它不会自动重试 —— '
        + '任务会留在看板上等人决定。',
      schema: z.object({
        taskId: z.string().describe('派发请求中给出的 Kanban taskId'),
        reason: z.string().describe('卡住的原因'),
      }),
    },
  );

  return [listTasks, addTask, completeTask, blockTask] as NamedStructuredTool[];
}

export type CreateKanbanPluginOptions = {
  board?: KanbanBoard;
  /** Optional Plugin-owned durable state. Studio does not select or interpret it. */
  stateStore?: KanbanStateStore;
};

export type KanbanPlugin = StudioPlugin & { board: KanbanBoard };

export function createKanbanToolkit(board: KanbanBoard): AgentToolkit {
  const declaredTools = buildTools(board);
  return {
    name: KANBAN_TOOLKIT_NAME,
    description: '共享任务看板：查看、拆解、完成与阻塞任务。',
    tools: declaredTools.map((declared, index) => ({
      tool: declared,
      operation: { title: TOOL_TITLES[index] ?? declared.name },
    })),
  };
}

export function createKanbanPlugin(options: CreateKanbanPluginOptions = {}): KanbanPlugin {
  const board = options.board ?? new KanbanBoard();
  const toolkit = createKanbanToolkit(board);
  const stateStore = options.stateStore;
  let context: StudioPluginContext | undefined;
  let unsubscribe: (() => void) | undefined;
  let persistenceTail = Promise.resolve();
  let persistenceError: Error | undefined;
  let dispatchRequested = false;
  let dispatchLoop: Promise<void> | undefined;
  let dispatchEnabled = false;
  const activeDispatches = new Set<Promise<void>>();

  function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  function schedulePersistence(): void {
    if (!stateStore) return;
    const snapshot = board.snapshot();
    persistenceTail = persistenceTail
      .then(() => stateStore.save(snapshot))
      .then(() => {
        persistenceError = undefined;
      })
      .catch((error) => {
        persistenceError = asError(error);
        context?.notify({
          type: 'kanban.persistence_failed',
          payload: { message: persistenceError.message },
        });
      });
  }

  function finishUnreportedTask(taskId: string, result: StudioDispatchResult): void {
    const task = board.get(taskId);
    if (!task || (task.status !== 'doing' && task.status !== 'waiting')) return;
    if (result.status === 'pending_interrupt') {
      if (task.status === 'doing') {
        board.wait(taskId, 'Pet invocation is waiting for external interaction.');
      }
      return;
    }
    if (result.status === 'failed') {
      board.block(taskId, result.error ?? 'Pet invocation failed.');
      return;
    }
    if (result.status === 'cancelled') {
      board.block(taskId, 'Pet invocation was cancelled.');
      return;
    }
    board.block(taskId, 'Pet invocation completed without reporting a Kanban task outcome.');
  }

  function trackDispatch(taskId: string, completion: Promise<StudioDispatchResult>): void {
    const tracked = completion
      .then((result) => finishUnreportedTask(taskId, result))
      .catch((error) => {
        const task = board.get(taskId);
        if (task?.status === 'doing' || task?.status === 'waiting') {
          board.block(taskId, asError(error).message);
        }
      });
    activeDispatches.add(tracked);
    void tracked.finally(() => activeDispatches.delete(tracked));
  }

  /**
   * 依赖满足即派发。
   *
   * 它逐个检查 ready 的任务 —— 一个任务排不上**不连累**其他已就绪的任务
   * (这正是旧 orchestrator 的 strict global FIFO 要避免的)。
   */
  async function runDispatchLoop(): Promise<void> {
    while (dispatchEnabled && context && dispatchRequested) {
      dispatchRequested = false;
      await persistenceTail;
      for (const task of board.ready()) {
        if (!dispatchEnabled || !context) return;
        // Persist doing before the external dispatch. A crash after this point
        // restores the task as blocked instead of silently dispatching twice.
        board.markDispatched(task.taskId);
        await persistenceTail;
        if (persistenceError) {
          board.block(task.taskId, `Kanban persistence failed: ${persistenceError.message}`);
          continue;
        }
        try {
          const receipt = await context.dispatch({
            petId: task.petId,
            input: { kind: 'request', request: buildTaskRequest(task) },
          });
          trackDispatch(task.taskId, receipt.completion);
        } catch (error) {
          board.block(task.taskId, asError(error).message);
        }
      }
    }
  }

  function dispatchReady(): void {
    if (!dispatchEnabled || !context) return;
    dispatchRequested = true;
    if (dispatchLoop) return;
    const running = runDispatchLoop();
    dispatchLoop = running;
    void running.then(
      () => {
        if (dispatchLoop === running) dispatchLoop = undefined;
        if (dispatchRequested) dispatchReady();
      },
      (error) => {
        if (dispatchLoop === running) dispatchLoop = undefined;
        context?.notify({
          type: 'kanban.dispatch_loop_failed',
          payload: { message: asError(error).message },
        });
      },
    );
  }

  return {
    board,
    name: KANBAN_TOOLKIT_NAME,
    toolkits: [toolkit],
    start: async (pluginContext) => {
      if (context) throw new Error('Kanban Plugin is already started.');
      if (stateStore) {
        const snapshot = await stateStore.load();
        if (snapshot) board.restore(snapshot);
        // Persist recovery transitions (notably doing -> blocked) before the
        // Plugin can dispatch any remaining todo task.
        await stateStore.save(board.snapshot());
      }
      context = pluginContext;
      dispatchEnabled = true;
      unsubscribe = board.subscribe((task) => {
        pluginContext.notify({
          type: `task.${task.status}`,
          payload: { taskId: task.taskId, petId: task.petId, note: task.note },
        });
        schedulePersistence();
        // 任一状态变化都可能解锁别的任务的依赖。
        dispatchReady();
      });
      dispatchReady();
    },
    stop: async () => {
      dispatchEnabled = false;
      dispatchRequested = false;
      await dispatchLoop;
      await Promise.allSettled([...activeDispatches]);
      await persistenceTail;
      unsubscribe?.();
      unsubscribe = undefined;
      context = undefined;
    },
  };
}
