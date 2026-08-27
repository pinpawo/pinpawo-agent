/**
 * Studio adapter for the independent Kanban task domain.
 *
 * The domain service owns tasks, dependencies, SQLite transactions and history.
 * This Plugin only maps a Kanban assignee to a Studio pet, defines its Agent
 * Toolkit, and projects committed mutations into Studio dispatch/events/HTTP hooks.
 */

import path from 'node:path';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentToolkit, NamedStructuredTool } from '@pinpawo/pet-agent';
import type { StudioPlugin, StudioPluginContext } from '@pinpawo/studio';
import type { StudioHttpRoutesHook } from '@pinpawo-plugin/studio-http';

import {
  createInMemoryKanbanTaskService,
  KanbanTaskService,
  SqliteKanbanTaskRepository,
  type KanbanTask,
} from './kanbanTaskService';

export const KANBAN_TOOLKIT_NAME = 'kanban';

const TOOL_TITLES = ['查看执行者', '查看任务', '新增任务', '完成任务', '阻塞任务'] as const;

function describeTask(task: KanbanTask): string {
  const deps = task.deps.length > 0 ? ` deps=[${task.deps.join(', ')}]` : '';
  const note = task.note ? ` note=${task.note}` : '';
  return `${task.taskId} [${task.status}] assignee=${task.assigneeId}${deps} ${task.brief}${note}`;
}

function buildTaskRequest(task: KanbanTask, dependencies: readonly KanbanTask[]): string {
  const dependencyResults = dependencies.length === 0
    ? []
    : [
        '',
        'Completed dependency results:',
        ...dependencies.map((dependency) => (
          `- ${dependency.taskId}: ${dependency.note ?? '(completed without a result summary)'}`
        )),
      ];
  return [
    `Kanban taskId: ${task.taskId}`,
    '',
    task.brief,
    ...dependencyResults,
    '',
    'When reporting completion or a block, pass this taskId to the Kanban tool.',
  ].join('\n');
}

function isActive(task: KanbanTask): boolean {
  return task.status === 'doing' || task.status === 'waiting';
}

function canReportCompletion(task: KanbanTask): boolean {
  return isActive(task) || task.status === 'blocked';
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

function buildTools(
  service: KanbanTaskService,
  readAssigneeIds: () => readonly string[] | null,
): NamedStructuredTool[] {
  const listAssignees = tool(
    async () => {
      const assigneeIds = readAssigneeIds();
      return !assigneeIds || assigneeIds.length === 0
        ? '(Kanban Plugin is not attached to a Studio Pet registry)'
        : assigneeIds.join('\n');
    },
    {
      name: 'kanban_assignee_list',
      description: '列出当前 Studio 中可以接收 Kanban 任务的 petId。新增任务前先从这里选择。',
      schema: z.object({}),
    },
  );

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
      const assigneeIds = readAssigneeIds();
      if (assigneeIds && !assigneeIds.includes(input.petId)) {
        return `unknown Studio petId "${input.petId}"; available: ${assigneeIds.join(', ') || '(none)'}`;
      }
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
      if (!canReportCompletion(task)) {
        return `Kanban task "${input.taskId}" is ${task.status}, not completable`;
      }
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

  return [listAssignees, listTasks, addTask, completeTask, blockTask] as NamedStructuredTool[];
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

export type InstalledKanbanPluginEnvironment = {
  workdir: string;
};

export function createKanbanToolkit(
  service: KanbanTaskService,
  readAssigneeIds: () => readonly string[] | null = () => null,
): AgentToolkit {
  const declaredTools = buildTools(service, readAssigneeIds);
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
  let assigneeIds: readonly string[] | null = null;
  const toolkit = createKanbanToolkit(service, () => assigneeIds);
  let context: StudioPluginContext | undefined;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeHttpRoute: (() => void) | undefined;
  let dispatchRequested = false;
  let dispatchLoop: Promise<void> | undefined;
  let dispatchEnabled = false;

  function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
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
          const dependencies = (await Promise.all(
            task.deps.map((taskId) => service.getTask(taskId)),
          )).filter((dependency): dependency is KanbanTask => dependency !== null);
          await context.dispatch({
            petId: task.assigneeId,
            request: buildTaskRequest(task, dependencies),
          });
        } catch (error) {
          // Admission failed before the Pet accepted the dispatch. Once accepted,
          // only Kanban Toolkit/domain mutations may complete or block this task.
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
      assigneeIds = pluginContext.listPets().map(({ petId }) => petId);
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
        assigneeIds = null;
        if (ownsService) await service.close().catch(() => undefined);
        throw error;
      }
    },
    stop: async () => {
      dispatchEnabled = false;
      dispatchRequested = false;
      await dispatchLoop;
      unsubscribeHttpRoute?.();
      unsubscribeHttpRoute = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      context = undefined;
      assigneeIds = null;
      if (ownsService) await service.close();
    },
  };
}

/** Installed-package entry used by the standalone Studio Plugin resolver. */
export function createStudioPlugin(
  value: Record<string, unknown> | undefined,
  environment: InstalledKanbanPluginEnvironment,
): KanbanPlugin {
  const options = value ?? {};
  const allowed = new Set(['databasePath', 'httpRoute']);
  const unknown = Object.keys(options).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Kanban Plugin option "${unknown}" is not supported.`);
  if (options.databasePath !== undefined && typeof options.databasePath !== 'string') {
    throw new Error('Kanban Plugin option "databasePath" must be a string.');
  }
  const httpRoute = options.httpRoute;
  if (
    httpRoute !== undefined
    && httpRoute !== false
    && (
      !httpRoute
      || typeof httpRoute !== 'object'
      || Array.isArray(httpRoute)
      || Object.keys(httpRoute).some((key) => key !== 'pluginName' && key !== 'path')
      || ('pluginName' in httpRoute && typeof httpRoute.pluginName !== 'string')
      || ('path' in httpRoute && typeof httpRoute.path !== 'string')
    )
  ) {
    throw new Error('Kanban Plugin option "httpRoute" must be false or a route object.');
  }
  const configuredPath = typeof options.databasePath === 'string'
    ? options.databasePath.trim()
    : '';
  const databasePath = configuredPath
    ? (path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(environment.workdir, configuredPath))
    : path.join(environment.workdir, '.pinpawo', 'kanban', 'tasks.sqlite');
  return createKanbanPlugin({
    databasePath,
    ...(httpRoute !== undefined
      ? { httpRoute: httpRoute as CreateKanbanPluginOptions['httpRoute'] }
      : {}),
  });
}
