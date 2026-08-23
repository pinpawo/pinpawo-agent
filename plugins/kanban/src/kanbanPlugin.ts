/**
 * Studio adapter for the independent Kanban task domain.
 *
 * The domain service owns tasks, dependencies, SQLite transactions and history.
 * This Plugin only maps a Kanban assignee to a Studio pet, defines its Agent
 * Toolkit, and projects committed mutations into Studio dispatch/events/HTTP hooks.
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentToolkit, NamedStructuredTool } from '@pinpawo/pet-agent';
import type {
  StudioDispatchResult,
  StudioPlugin,
  StudioPluginContext,
} from '@pinpawo/studio';
import type { StudioHttpRoutesHook } from '@pinpawo-plugin/studio-http';

import {
  createInMemoryKanbanTaskService,
  KanbanTaskService,
  SqliteKanbanTaskRepository,
  type KanbanTask,
} from './kanbanTaskService';

export const KANBAN_TOOLKIT_NAME = 'kanban';

const TOOL_TITLES = ['查看任务', '新增任务', '完成任务', '阻塞任务'] as const;

function describeTask(task: KanbanTask): string {
  const deps = task.deps.length > 0 ? ` deps=[${task.deps.join(', ')}]` : '';
  const note = task.note ? ` note=${task.note}` : '';
  return `${task.taskId} [${task.status}] assignee=${task.assigneeId}${deps} ${task.brief}${note}`;
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

function isActive(task: KanbanTask): boolean {
  return task.status === 'doing' || task.status === 'waiting';
}

function readNonNegativeQueryInteger(
  value: string | null,
  field: string,
): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`Kanban ${field} must be a non-negative integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Kanban ${field} must be a non-negative integer.`);
  }
  return parsed;
}

function buildTools(service: KanbanTaskService): NamedStructuredTool[] {
  const listTasks = tool(
    async () => {
      const tasks = (await service.readSnapshot()).tasks;
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
      // `petId` belongs to this Studio-facing Toolkit adapter. The domain only
      // receives the generic assigneeId.
      const mutation = await service.createTask({
        assigneeId: input.petId,
        brief: input.brief,
        ...(input.dependsOn ? { dependsOn: input.dependsOn } : {}),
      });
      return `added ${mutation.task.taskId}`;
    },
    {
      name: 'kanban_task_add',
      description:
        '新增一个任务并指派给某个 pet。用 dependsOn 声明它依赖哪些任务先完成;'
        + '依赖全部完成后该任务才会被派发。',
      schema: z.object({
        petId: z.string().describe('由哪个 Studio pet 执行'),
        brief: z.string().describe('任务描述，接收方将以此为唯一输入'),
        dependsOn: z.array(z.string()).optional().describe('依赖的 taskId'),
      }),
    },
  );

  const completeTask = tool(
    async (input) => {
      const task = await service.getTask(input.taskId);
      if (!task) return `unknown Kanban taskId "${input.taskId}"`;
      if (!isActive(task)) return `Kanban task "${input.taskId}" is ${task.status}, not active`;
      await service.completeTask(task.taskId, input.result);
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
      const task = await service.getTask(input.taskId);
      if (!task) return `unknown Kanban taskId "${input.taskId}"`;
      if (!isActive(task)) return `Kanban task "${input.taskId}" is ${task.status}, not active`;
      await service.blockTask(task.taskId, input.reason);
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
  /** An application-owned Kanban service. Supplied services are not closed by this adapter. */
  service?: KanbanTaskService;
  /** Persistent SQLite file for a Plugin-owned service. Omit for ephemeral in-memory state. */
  databasePath?: string;
  /** Optional reverse contribution into an installed Studio HTTP Plugin. */
  httpRoute?: false | {
    pluginName?: string;
    path?: string;
  };
};

export type KanbanPlugin = StudioPlugin & { service: KanbanTaskService };

export function createKanbanToolkit(service: KanbanTaskService): AgentToolkit {
  const declaredTools = buildTools(service);
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
  const ownsService = !options.service;
  const service = options.service ?? (options.databasePath
    ? new KanbanTaskService(new SqliteKanbanTaskRepository(options.databasePath))
    : createInMemoryKanbanTaskService());
  const toolkit = createKanbanToolkit(service);
  let context: StudioPluginContext | undefined;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeHttpRoute: (() => void) | undefined;
  let dispatchRequested = false;
  let dispatchLoop: Promise<void> | undefined;
  let dispatchEnabled = false;
  const activeDispatches = new Set<Promise<void>>();

  function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  async function finishUnreportedTask(taskId: string, result: StudioDispatchResult): Promise<void> {
    const task = await service.getTask(taskId);
    if (!task || !isActive(task)) return;
    if (result.status === 'waiting') {
      if (task.status === 'doing') {
        const continuation = result.pendingContinuation;
        if (!continuation) {
          await service.blockTask(
            taskId,
            'Pet reported waiting without a public continuation projection.',
          );
          return;
        }
        await service.waitForContinuation(taskId, continuation);
      }
      return;
    }
    if (result.status === 'failed') {
      await service.blockTask(taskId, result.error ?? 'Pet invocation failed.');
      return;
    }
    if (result.status === 'cancelled') {
      await service.blockTask(taskId, 'Pet invocation was cancelled.');
      return;
    }
    await service.blockTask(taskId, 'Pet invocation completed without reporting a Kanban task outcome.');
  }

  function trackDispatch(taskId: string, completion: Promise<StudioDispatchResult>): void {
    const tracked = completion
      .then((result) => finishUnreportedTask(taskId, result))
      .catch(async (error) => {
        const task = await service.getTask(taskId);
        if (task && isActive(task)) await service.blockTask(taskId, asError(error).message);
      });
    activeDispatches.add(tracked);
    void tracked.finally(() => activeDispatches.delete(tracked));
  }

  /** Claim is already a committed Kanban operation before Studio dispatch begins. */
  async function runDispatchLoop(): Promise<void> {
    while (dispatchEnabled && context && dispatchRequested) {
      dispatchRequested = false;
      while (dispatchEnabled && context) {
        const mutation = await service.claimNextReadyTask();
        if (!mutation) break;
        const task = mutation.task;
        try {
          const receipt = await context.dispatch({
            petId: task.assigneeId,
            input: { kind: 'request', request: buildTaskRequest(task) },
          });
          trackDispatch(task.taskId, receipt.completion);
        } catch (error) {
          await service.blockTask(task.taskId, asError(error).message);
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
    service,
    name: KANBAN_TOOLKIT_NAME,
    toolkits: [toolkit],
    start: async (pluginContext) => {
      if (context) throw new Error('Kanban Plugin is already started.');
      context = pluginContext;
      unsubscribe = service.subscribe((mutation) => {
        pluginContext.notify({
          type: `task.${mutation.task.status}`,
          payload: {
            taskId: mutation.task.taskId,
            // This is a Studio event projection, so retain the Studio-facing
            // target name. The Kanban domain itself only has assigneeId.
            petId: mutation.task.assigneeId,
            note: mutation.task.note,
            sequence: mutation.event.sequence,
          },
        });
        dispatchReady();
      });
      try {
        await service.init();
        const httpRoute = options.httpRoute;
        if (httpRoute !== false) {
          unsubscribeHttpRoute = pluginContext.hooks.contribute<StudioHttpRoutesHook>(
            httpRoute?.pluginName ?? 'http',
            'routes',
            (routes) => {
              const snapshotPath = httpRoute?.path ?? '/kanban';
              const unregisterSnapshot = routes.register({
                method: 'GET',
                path: snapshotPath,
                handle: async () => ({ kind: 'json', body: await service.readSnapshot() }),
              });
              let unregisterEvents: (() => void) | undefined;
              try {
                unregisterEvents = routes.register({
                  method: 'GET',
                  path: `${snapshotPath}/events`,
                  handle: async ({ url }) => {
                    try {
                      const events = await service.listTaskEvents(
                        readNonNegativeQueryInteger(url.searchParams.get('after'), 'event cursor'),
                        readNonNegativeQueryInteger(url.searchParams.get('limit'), 'event limit'),
                      );
                      return { kind: 'json', body: { events } };
                    } catch (error) {
                      return {
                        kind: 'json',
                        status: 400,
                        body: { error: asError(error).message },
                      };
                    }
                  },
                });
              } catch (error) {
                unregisterSnapshot();
                throw error;
              }
              return () => {
                unregisterEvents?.();
                unregisterSnapshot();
              };
            },
          );
        }
        dispatchEnabled = true;
        dispatchReady();
      } catch (error) {
        unsubscribeHttpRoute?.();
        unsubscribeHttpRoute = undefined;
        unsubscribe?.();
        unsubscribe = undefined;
        context = undefined;
        if (ownsService) await service.close().catch(() => undefined);
        throw error;
      }
    },
    stop: async () => {
      dispatchEnabled = false;
      dispatchRequested = false;
      await dispatchLoop;
      await Promise.allSettled([...activeDispatches]);
      unsubscribeHttpRoute?.();
      unsubscribeHttpRoute = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      context = undefined;
      if (ownsService) await service.close();
    },
  };
}
