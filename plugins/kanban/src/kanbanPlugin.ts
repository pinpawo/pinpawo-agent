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
import type {
  StudioPetRegistration,
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

const TOOL_TITLES = ['查看执行者', '查看任务', '新增任务', '完成任务', '阻塞任务'] as const;

function describeTask(task: KanbanTask): string {
  const deps = task.deps.length > 0 ? ` deps=[${task.deps.join(', ')}]` : '';
  const note = task.note ? ` note=${task.note}` : '';
  return `${task.taskId} [${task.status}] assignee=${task.assigneeId}${deps} ${task.brief}${note}`;
}

function describeAssignee(assignee: StudioPetRegistration): string {
  const details = [
    `petId=${assignee.petId}`,
    `name=${assignee.name}`,
    ...(assignee.role ? [`role=${assignee.role}`] : []),
    ...(assignee.serviceSummary ? [`service=${assignee.serviceSummary}`] : []),
  ];
  return details.join(' ');
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
  readAssignees: () => readonly StudioPetRegistration[] | null,
): NamedStructuredTool[] {
  const listAssignees = tool(
    async () => {
      const assignees = readAssignees();
      return !assignees || assignees.length === 0
        ? '(Kanban Plugin is not attached to a Studio Pet registry)'
        : assignees.map(describeAssignee).join('\n');
    },
    {
      name: 'kanban_assignee_list',
      description: '读取当前 Studio 可接收 task 的 Pet 快照，返回 petId、角色与服务摘要，用于选择职责匹配的执行者。',
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
      description:
        '读取调用时刻的 Kanban task 快照，返回状态、执行者、依赖与已有结果。'
        + '一次规划读取一份快照即可形成当前决策的事实基线；新增 task 返回的 taskId 是持久化确认，'
        + '后续变化通过 Studio 事件与 Trigger 流转。',
      schema: z.object({}),
    },
  );

  const addTask = tool(
    async (input) => {
      const assignees = readAssignees();
      if (assignees && !assignees.some(({ petId }) => petId === input.petId)) {
        return `unknown Studio petId "${input.petId}"; available: ${assignees.map(({ petId }) => petId).join(', ') || '(none)'}`;
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
        '创建并指派一个可由单个 Pet 独立交付的完整 task。一次调用只创建一个 task；'
        + 'dependsOn 表示真实的交付依赖，依赖完成后进入可派发状态。返回的 taskId 是持久化成功的确认。',
      schema: z.object({
        petId: z.string().describe('负责完整交付的 Studio petId'),
        brief: z.string().describe('接收方的完整任务输入，包含目标、完成标准、必要上下文与应保留的证据；同一交付的实现步骤统一写入此 brief'),
        dependsOn: z.array(z.string()).optional().describe('本 task 开始前必须完成的真实前置交付 taskId'),
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
      description: '由当前 task 的执行者按 taskId 提交完成状态和结果摘要，供依赖 task 使用并推进其可派发状态。',
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
        '由当前 task 的执行者按 taskId 提交阻塞状态和原因。阻塞记录保留在看板中，'
        + '后续显式决策负责重试、调整或替代方案。',
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
  };
  /** Automatic by default; manual keeps ready tasks queued until explicitly started. */
  dispatchMode?: KanbanDispatchMode;
};

export type KanbanDispatchMode = 'automatic' | 'manual';

export type KanbanPlugin = StudioPlugin & { service: KanbanTaskService };

export type InstalledKanbanPluginEnvironment = {
  workdir: string;
};

export function createKanbanToolkit(
  service: KanbanTaskService,
  readAssignees: () => readonly StudioPetRegistration[] | null = () => null,
): AgentToolkit {
  const declaredTools = buildTools(service, readAssignees);
  return {
    name: KANBAN_TOOLKIT_NAME,
    description: 'Studio 的共享 task 领域接口：按 Pet 职责登记完整交付、表达依赖，并读取或提交 task 生命周期状态。',
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
  let assignees: readonly StudioPetRegistration[] | null = null;
  const toolkit = createKanbanToolkit(service, () => assignees);
  let context: StudioPluginContext | undefined;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeHttpRoute: (() => void) | undefined;
  let dispatchRequested = false;
  let dispatchLoop: Promise<void> | undefined;
  let dispatchEnabled = false;
  const dispatchMode = options.dispatchMode ?? 'automatic';

  if (dispatchMode !== 'automatic' && dispatchMode !== 'manual') {
    throw new Error('Kanban dispatchMode must be "automatic" or "manual".');
  }

  function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  async function dispatchClaimedTask(task: KanbanTask): Promise<void> {
    const activeContext = context;
    if (!dispatchEnabled || !activeContext) throw new Error('Kanban Plugin is not running.');
    try {
      const dependencies = (await Promise.all(
        task.deps.map((taskId) => service.getTask(taskId)),
      )).filter((dependency): dependency is KanbanTask => dependency !== null);
      await activeContext.dispatch({
        petId: task.assigneeId,
        request: buildTaskRequest(task, dependencies),
      });
    } catch (error) {
      // Admission failed before the Pet accepted the dispatch. Once accepted,
      // only Kanban Toolkit/domain mutations may complete or block this task.
      await service.blockTask(task.taskId, asError(error).message);
      throw error;
    }
  }

  /** Claim is already a committed Kanban operation before Studio dispatch begins. */
  async function runDispatchLoop(): Promise<void> {
    while (dispatchEnabled && context && dispatchRequested) {
      dispatchRequested = false;
      while (dispatchEnabled && context) {
        const mutation = await service.claimNextReadyTask();
        if (!mutation) break;
        await dispatchClaimedTask(mutation.task).catch(() => undefined);
      }
    }
  }

  async function startTask(taskId: string): Promise<KanbanTask> {
    const mutation = await service.claimReadyTask(taskId);
    await dispatchClaimedTask(mutation.task);
    return mutation.task;
  }

  function dispatchReady(): void {
    if (dispatchMode !== 'automatic' || !dispatchEnabled || !context) return;
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
      assignees = pluginContext.listPets();
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
              const snapshotPath = '/kanban';
              const unregisterSnapshot = routes.register({
                method: 'GET',
                path: snapshotPath,
                handle: async () => ({
                  kind: 'json',
                  body: { ...await service.readSnapshot(), dispatchMode },
                }),
              });
              let unregisterEvents: (() => void) | undefined;
              let unregisterControl: (() => void) | undefined;
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
                unregisterControl = routes.register({
                  method: 'POST',
                  path: `${snapshotPath}/control`,
                  handle: async ({ readJson }) => {
                    try {
                      const value = await readJson();
                      if (!value || typeof value !== 'object' || Array.isArray(value)) {
                        throw new Error('Kanban control request must be an object.');
                      }
                      const input = value as Record<string, unknown>;
                      if (input.action !== 'start' || typeof input.taskId !== 'string'
                        || Object.keys(input).some((key) => key !== 'action' && key !== 'taskId')) {
                        throw new Error('Kanban control requires action "start" and taskId.');
                      }
                      return {
                        kind: 'json',
                        status: 202,
                        body: { task: await startTask(input.taskId) },
                      };
                    } catch (error) {
                      return {
                        kind: 'json',
                        status: 409,
                        body: { error: asError(error).message },
                      };
                    }
                  },
                });
              } catch (error) {
                unregisterControl?.();
                unregisterEvents?.();
                unregisterSnapshot();
                throw error;
              }
              return () => {
                unregisterControl?.();
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
        assignees = null;
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
      assignees = null;
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
  const allowed = new Set(['databasePath', 'httpRoute', 'dispatchMode']);
  const unknown = Object.keys(options).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Kanban Plugin option "${unknown}" is not supported.`);
  if (options.databasePath !== undefined && typeof options.databasePath !== 'string') {
    throw new Error('Kanban Plugin option "databasePath" must be a string.');
  }
  if (options.dispatchMode !== undefined
    && options.dispatchMode !== 'automatic'
    && options.dispatchMode !== 'manual') {
    throw new Error('Kanban Plugin option "dispatchMode" must be automatic or manual.');
  }
  const httpRoute = options.httpRoute;
  if (
    httpRoute !== undefined
    && httpRoute !== false
    && (
      !httpRoute
      || typeof httpRoute !== 'object'
      || Array.isArray(httpRoute)
      || Object.keys(httpRoute).some((key) => key !== 'pluginName')
      || ('pluginName' in httpRoute && typeof httpRoute.pluginName !== 'string')
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
    ...(options.dispatchMode === undefined
      ? {}
      : { dispatchMode: options.dispatchMode as KanbanDispatchMode }),
    ...(httpRoute !== undefined
      ? { httpRoute: httpRoute as CreateKanbanPluginOptions['httpRoute'] }
      : {}),
  });
}
