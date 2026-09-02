/** Studio adapter for the independent Kanban task domain.
 *
 * Kanban records task facts and explicit user assignment. It deliberately does
 * not inspect Studio pets or dispatch work: a Trigger rule consumes task.assigned.
 */

import path from 'node:path';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentToolkit, NamedStructuredTool } from '@pinpawo/pet-agent';
import type { StudioPlugin } from '@pinpawo/studio';
import type { StudioHttpRoutesHook } from '@pinpawo-plugin/studio-http';

import {
  createInMemoryKanbanTaskService,
  KanbanTaskService,
  SqliteKanbanTaskRepository,
  type KanbanTask,
  type KanbanTaskMutation,
} from './kanbanTaskService';

export const KANBAN_TOOLKIT_NAME = 'kanban';
export const KANBAN_PLANNING_TOOLKIT_NAME = 'kanban-planning';
export const KANBAN_EXECUTION_TOOLKIT_NAME = 'kanban-execution';
export const KANBAN_OBSERVATION_TOOLKIT_NAME = 'kanban-observation';

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function describeTask(task: KanbanTask): string {
  const deps = task.deps.length > 0 ? ` deps=[${task.deps.join(', ')}]` : '';
  const assignee = task.assigneeId ? ` assignee=${task.assigneeId}` : '';
  const note = task.note ? ` note=${task.note}` : '';
  return [`${task.taskId} [${task.status}]${assignee}${deps} title=${task.title}${note}`, `detail=${task.detail}`].join('\n');
}

function isStarted(task: KanbanTask): boolean {
  return task.status === 'doing' || task.status === 'waiting';
}

function canReportCompletion(task: KanbanTask): boolean {
  return isStarted(task) || task.status === 'blocked';
}

function readNonNegativeQueryInteger(value: string | null, field: string): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`Kanban ${field} must be a non-negative integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Kanban ${field} must be a non-negative integer.`);
  return parsed;
}

function buildTools(service: KanbanTaskService): {
  listTasks: NamedStructuredTool;
  addTask: NamedStructuredTool;
  startTask: NamedStructuredTool;
  completeTask: NamedStructuredTool;
  blockTask: NamedStructuredTool;
} {
  const listTasks = tool(async () => {
    const tasks = (await service.readSnapshot()).tasks;
    return tasks.length === 0 ? '(no tasks yet)' : tasks.map(describeTask).join('\n');
  }, {
    name: 'kanban_task_list',
    description: '读取当前 Kanban task 快照，返回状态、已选执行目标、依赖、详情与已有结果。',
    schema: z.object({}),
  });
  const addTask = tool(async (input) => {
    const mutation = await service.createTask({
      title: input.title,
      detail: input.detail,
      ...(input.dependsOn ? { dependsOn: input.dependsOn } : {}),
    });
    return `added ${mutation.task.taskId}`;
  }, {
    name: 'kanban_task_add',
    description: '登记一个尚未分配执行者的完整交付 task。一次调用只创建一个 task；真实依赖使用 dependsOn 表达。任务由用户在 Kanban 中选择执行目标后才会派发。',
    schema: z.object({
      title: z.string().max(160).describe('看板列表中识别完整交付主题的简短标题'),
      detail: z.string().describe('完整任务详情：目标、完成标准、必要上下文与应保留的证据'),
      dependsOn: z.array(z.string()).optional().describe('此 task 被分配前必须完成的真实前置 taskId'),
    }),
  });
  const startTask = tool(async (input) => {
    const task = await service.getTask(input.taskId);
    if (!task) return `unknown Kanban taskId "${input.taskId}"`;
    if (task.status !== 'assigned') return `Kanban task "${input.taskId}" is ${task.status}, not assigned`;
    await service.startAssignedTask(task.taskId);
    return `started ${task.taskId}`;
  }, {
    name: 'kanban_task_start',
    description: '接收到已分配的 task 后，执行者以 taskId 明确记录实际开始。',
    schema: z.object({ taskId: z.string().describe('派发请求中给出的 Kanban taskId') }),
  });
  const completeTask = tool(async (input) => {
    const task = await service.getTask(input.taskId);
    if (!task) return `unknown Kanban taskId "${input.taskId}"`;
    if (!canReportCompletion(task)) return `Kanban task "${input.taskId}" is ${task.status}, not completable`;
    await service.completeTask(task.taskId, input.result);
    return `completed ${task.taskId}`;
  }, {
    name: 'kanban_task_complete',
    description: '由已开始 task 的执行者按 taskId 提交完成状态和结果摘要。',
    schema: z.object({ taskId: z.string().describe('派发请求中的 Kanban taskId'), result: z.string().describe('完成结果或产出摘要') }),
  });
  const blockTask = tool(async (input) => {
    const task = await service.getTask(input.taskId);
    if (!task) return `unknown Kanban taskId "${input.taskId}"`;
    if (!isStarted(task) && task.status !== 'assigned') return `Kanban task "${input.taskId}" is ${task.status}, not active`;
    await service.blockTask(task.taskId, input.reason);
    return `blocked ${task.taskId}`;
  }, {
    name: 'kanban_task_block',
    description: '由已分配或已开始 task 的执行者按 taskId 提交阻塞状态与原因。',
    schema: z.object({ taskId: z.string().describe('派发请求中的 Kanban taskId'), reason: z.string().describe('阻塞原因') }),
  });
  return { listTasks, addTask, startTask, completeTask, blockTask };
}

function toolkit(name: string, description: string, tools: readonly NamedStructuredTool[], titles: readonly string[]): AgentToolkit {
  return {
    name,
    description,
    tools: tools.map((declared, index) => ({ tool: declared, operation: { title: titles[index] ?? declared.name } })),
  };
}

export function createKanbanToolkit(service: KanbanTaskService): AgentToolkit {
  const tools = buildTools(service);
  return toolkit(KANBAN_TOOLKIT_NAME, '共享 task 领域接口：登记任务、读取状态并提交执行生命周期。用户分配与 Studio 路由不属于此 Toolkit。', [tools.listTasks, tools.addTask, tools.startTask, tools.completeTask, tools.blockTask], ['查看任务', '新增任务', '开始任务', '完成任务', '阻塞任务']);
}

export function createKanbanPlanningToolkit(service: KanbanTaskService): AgentToolkit {
  const tools = buildTools(service);
  return toolkit(KANBAN_PLANNING_TOOLKIT_NAME, 'task 规划接口：查看当前 task 图并登记完整交付及其依赖。它不选择执行者，也不派发工作。', [tools.listTasks, tools.addTask], ['查看任务', '新增任务']);
}

export function createKanbanExecutionToolkit(service: KanbanTaskService): AgentToolkit {
  const tools = buildTools(service);
  return toolkit(KANBAN_EXECUTION_TOOLKIT_NAME, 'task 执行回报接口：执行者对已分配 task 记录开始、完成或阻塞。', [tools.listTasks, tools.startTask, tools.completeTask, tools.blockTask], ['查看任务', '开始任务', '完成任务', '阻塞任务']);
}

export function createKanbanObservationToolkit(service: KanbanTaskService): AgentToolkit {
  const tools = buildTools(service);
  return toolkit(KANBAN_OBSERVATION_TOOLKIT_NAME, '只读 task 观察接口：读取当前 task 图、执行状态、依赖与结果。', [tools.listTasks], ['查看任务']);
}

export type CreateKanbanPluginOptions = {
  service?: KanbanTaskService;
  databasePath?: string;
  httpRoute?: false | { pluginName?: string };
};

export type KanbanPlugin = StudioPlugin & { service: KanbanTaskService };
export type InstalledKanbanPluginEnvironment = { workdir: string };

function eventTypeFor(mutation: KanbanTaskMutation): string {
  switch (mutation.event.eventType) {
    case 'assigned': return 'task.assigned';
    case 'started': return 'task.started';
    case 'completed': return 'task.done';
    case 'blocked':
    case 'recovered': return 'task.blocked';
    default: return `task.${mutation.task.status}`;
  }
}

export function createKanbanPlugin(options: CreateKanbanPluginOptions = {}): KanbanPlugin {
  const ownsService = !options.service;
  const service = options.service ?? (options.databasePath
    ? new KanbanTaskService(new SqliteKanbanTaskRepository(options.databasePath))
    : createInMemoryKanbanTaskService());
  const toolkits = [
    createKanbanToolkit(service),
    createKanbanPlanningToolkit(service),
    createKanbanExecutionToolkit(service),
    createKanbanObservationToolkit(service),
  ];
  let unsubscribe: (() => void) | undefined;
  let unsubscribeHttpRoute: (() => void) | undefined;

  return {
    service,
    name: KANBAN_TOOLKIT_NAME,
    toolkits,
    start: async (context) => {
      unsubscribe = service.subscribe((mutation) => {
        context.notify({
          type: eventTypeFor(mutation),
          payload: {
            taskId: mutation.task.taskId,
            ...(mutation.task.assigneeId === undefined ? {} : { assigneeId: mutation.task.assigneeId }),
            title: mutation.task.title,
            detail: mutation.task.detail,
            deps: mutation.task.deps,
            ...(mutation.task.note === undefined ? {} : { note: mutation.task.note }),
            sequence: mutation.event.sequence,
          },
        });
      });
      await service.init();
      if (options.httpRoute === false) return;
      unsubscribeHttpRoute = context.hooks.contribute<StudioHttpRoutesHook>(
        options.httpRoute?.pluginName ?? 'http', 'routes', (routes) => {
          const base = '/kanban';
          const removeSnapshot = routes.register({ method: 'GET', path: base, handle: async () => ({ kind: 'json', body: await service.readSnapshot() }) });
          const removeEvents = routes.register({ method: 'GET', path: `${base}/events`, handle: async ({ url }) => {
            try {
              return { kind: 'json', body: { events: await service.listTaskEvents(readNonNegativeQueryInteger(url.searchParams.get('after'), 'event cursor'), readNonNegativeQueryInteger(url.searchParams.get('limit'), 'event limit')) } };
            } catch (error) { return { kind: 'json', status: 400, body: { error: asError(error).message } }; }
          } });
          const removeControl = routes.register({ method: 'POST', path: `${base}/control`, handle: async ({ readJson }) => {
            try {
              const value = await readJson();
              if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Kanban control request must be an object.');
              const input = value as Record<string, unknown>;
              if (input.action !== 'assign' || typeof input.taskId !== 'string' || typeof input.assigneeId !== 'string' || Object.keys(input).some((key) => !['action', 'taskId', 'assigneeId'].includes(key))) {
                throw new Error('Kanban control requires action "assign", taskId, and assigneeId.');
              }
              return { kind: 'json', status: 202, body: { task: (await service.assignTask(input.taskId, input.assigneeId)).task } };
            } catch (error) { return { kind: 'json', status: 409, body: { error: asError(error).message } }; }
          } });
          return () => { removeControl(); removeEvents(); removeSnapshot(); };
        },
      );
    },
    stop: async () => {
      unsubscribeHttpRoute?.(); unsubscribeHttpRoute = undefined;
      unsubscribe?.(); unsubscribe = undefined;
      if (ownsService) await service.close();
    },
  };
}

export function createStudioPlugin(value: Record<string, unknown> | undefined, environment: InstalledKanbanPluginEnvironment): KanbanPlugin {
  const options = value ?? {};
  const allowed = new Set(['databasePath', 'httpRoute']);
  const unknown = Object.keys(options).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Kanban Plugin option "${unknown}" is not supported.`);
  if (options.databasePath !== undefined && typeof options.databasePath !== 'string') throw new Error('Kanban Plugin option "databasePath" must be a string.');
  const httpRoute = options.httpRoute;
  if (httpRoute !== undefined && httpRoute !== false && (!httpRoute || typeof httpRoute !== 'object' || Array.isArray(httpRoute) || Object.keys(httpRoute).some((key) => key !== 'pluginName') || ('pluginName' in httpRoute && typeof httpRoute.pluginName !== 'string'))) {
    throw new Error('Kanban Plugin option "httpRoute" must be false or a route object.');
  }
  const configuredPath = typeof options.databasePath === 'string' ? options.databasePath.trim() : '';
  return createKanbanPlugin({
    databasePath: configuredPath ? (path.isAbsolute(configuredPath) ? configuredPath : path.resolve(environment.workdir, configuredPath)) : path.join(environment.workdir, '.pinpawo', 'kanban', 'tasks.sqlite'),
    ...(httpRoute === undefined ? {} : { httpRoute: httpRoute as false | { pluginName?: string } }),
  });
}
