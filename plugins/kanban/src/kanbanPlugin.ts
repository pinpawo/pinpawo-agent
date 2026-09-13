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
  type KanbanTaskDeletion,
  type KanbanTaskRelationship,
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
  const assignee = task.assigneeId ? ` assignee=${task.assigneeId}` : '';
  const note = task.note ? ` note=${task.note}` : '';
  return [`${task.taskId} [${task.status}]${assignee} title=${task.title}${note}`, `detail=${task.detail}`].join('\n');
}

function describeRelationship(relationship: KanbanTaskRelationship): string {
  return `${relationship.sourceTaskId} --[${relationship.type}]-- ${relationship.targetTaskId}`;
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
  linkTasks: NamedStructuredTool;
  unlinkTasks: NamedStructuredTool;
  removeTask: NamedStructuredTool;
  startTask: NamedStructuredTool;
  completeTask: NamedStructuredTool;
  blockTask: NamedStructuredTool;
} {
  const listTasks = tool(async () => {
    const snapshot = await service.readSnapshot();
    const tasks = snapshot.tasks.length === 0 ? '(no tasks yet)' : snapshot.tasks.map(describeTask).join('\n');
    const relationships = snapshot.relationships.length === 0
      ? '(no task relationships)'
      : snapshot.relationships.map(describeRelationship).join('\n');
    return `tasks:\n${tasks}\n\nrelationships:\n${relationships}`;
  }, {
    name: 'kanban_task_list',
    description: '读取当前 Kanban task 图，返回状态、已选执行目标、任务关联、详情与已有结果。',
    schema: z.object({}),
  });
  const addTask = tool(async (input) => {
    const mutation = await service.createTask({
      title: input.title,
      detail: input.detail,
      ...(input.relatedTaskIds ? { relatedTaskIds: input.relatedTaskIds } : {}),
    });
    return `added ${mutation.task.taskId}`;
  }, {
    name: 'kanban_task_add',
    description: '登记一个尚未分配执行者的完整交付 task。一次调用只创建一个 task；可直接关联已有 task，但关联不阻止分配或执行。任务由用户在 Kanban 中选择执行目标后才会派发。',
    schema: z.object({
      title: z.string().max(160).describe('看板列表中识别完整交付主题的简短标题'),
      detail: z.string().describe('完整任务详情：目标、完成标准、必要上下文与应保留的证据'),
      relatedTaskIds: z.array(z.string()).optional().describe('与此 task 有直接上下文关联的已有 taskId；不代表执行前置条件'),
    }),
  });
  const linkTasks = tool(async (input) => {
    await service.linkTasks(input.sourceTaskId, input.targetTaskId);
    return `related ${input.sourceTaskId} -- ${input.targetTaskId}`;
  }, {
    name: 'kanban_task_link',
    description: '为两个已有 task 添加直接的上下文关联。关联仅用于浏览任务图，不会阻止分配或执行。',
    schema: z.object({
      sourceTaskId: z.string().describe('关联的一方 taskId，顺序无关'),
      targetTaskId: z.string().describe('关联的另一方 taskId'),
    }),
  });
  const unlinkTasks = tool(async (input) => {
    await service.unlinkTasks(input.sourceTaskId, input.targetTaskId);
    return `unlinked ${input.sourceTaskId} -- ${input.targetTaskId}`;
  }, {
    name: 'kanban_task_unlink',
    description: '移除两个 task 之间的直接关联，不影响任何 task 本身。',
    schema: z.object({
      sourceTaskId: z.string().describe('关联的一方 taskId，顺序无关'),
      targetTaskId: z.string().describe('关联的另一方 taskId'),
    }),
  });
  const removeTask = tool(async (input) => {
    await service.deleteTask(input.taskId);
    return `deleted ${input.taskId}`;
  }, {
    name: 'kanban_task_remove',
    description: '删除错误或不再需要的 task。仅删除该 task、它的关联和历史记录；不会删除关联的其他 task。',
    schema: z.object({ taskId: z.string().describe('要删除的 Kanban taskId') }),
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
  return { listTasks, addTask, linkTasks, unlinkTasks, removeTask, startTask, completeTask, blockTask };
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
  return toolkit(KANBAN_TOOLKIT_NAME, '共享 task 领域接口：维护任务图并提交执行生命周期。用户分配与 Studio 路由不属于此 Toolkit。', [tools.listTasks, tools.addTask, tools.linkTasks, tools.unlinkTasks, tools.removeTask, tools.startTask, tools.completeTask, tools.blockTask], ['查看任务图', '新增任务', '关联任务', '取消关联', '删除任务', '开始任务', '完成任务', '阻塞任务']);
}

export function createKanbanPlanningToolkit(service: KanbanTaskService): AgentToolkit {
  const tools = buildTools(service);
  return toolkit(KANBAN_PLANNING_TOOLKIT_NAME, 'task 规划接口：查看并维护共享 task 图。它不选择执行者，也不派发工作。', [tools.listTasks, tools.addTask, tools.linkTasks, tools.unlinkTasks, tools.removeTask], ['查看任务图', '新增任务', '关联任务', '取消关联', '删除任务']);
}

export function createKanbanExecutionToolkit(service: KanbanTaskService): AgentToolkit {
  const tools = buildTools(service);
  return toolkit(KANBAN_EXECUTION_TOOLKIT_NAME, 'task 执行回报接口：执行者对已分配 task 记录开始、完成或阻塞。', [tools.listTasks, tools.startTask, tools.completeTask, tools.blockTask], ['查看任务', '开始任务', '完成任务', '阻塞任务']);
}

export function createKanbanObservationToolkit(service: KanbanTaskService): AgentToolkit {
  const tools = buildTools(service);
  return toolkit(KANBAN_OBSERVATION_TOOLKIT_NAME, '只读 task 观察接口：读取当前 task 图、执行状态与结果。', [tools.listTasks], ['查看任务图']);
}

export type CreateKanbanPluginOptions = {
  service?: KanbanTaskService;
  databasePath?: string;
  httpRoute?: false | { pluginName?: string };
};

export type KanbanPlugin = StudioPlugin & { service: KanbanTaskService };
export type InstalledKanbanPluginEnvironment = { workdir: string };

function eventTypeFor(mutation: KanbanTaskMutation | KanbanTaskDeletion): string {
  if (!('event' in mutation)) return 'task.deleted';
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
        if (!('event' in mutation)) {
          context.notify({
            type: eventTypeFor(mutation),
            payload: {
              taskId: mutation.task.taskId,
              title: mutation.task.title,
              detail: mutation.task.detail,
              removedRelationships: mutation.removedRelationships,
            },
          });
          return;
        }
        context.notify({
          type: eventTypeFor(mutation),
          payload: {
            taskId: mutation.task.taskId,
            ...(mutation.task.assigneeId === undefined ? {} : { assigneeId: mutation.task.assigneeId }),
            title: mutation.task.title,
            detail: mutation.task.detail,
            ...(mutation.event.eventType === 'assigned' && mutation.event.note !== undefined
              ? { assignmentNote: mutation.event.note }
              : {}),
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
              if (input.action === 'delete' && typeof input.taskId === 'string' && Object.keys(input).every((key) => ['action', 'taskId'].includes(key))) {
                const deleted = await service.deleteTask(input.taskId);
                return { kind: 'json', status: 200, body: { deletedTaskId: deleted.task.taskId, removedRelationships: deleted.removedRelationships } };
              }
              if (input.action !== 'assign' || typeof input.taskId !== 'string' || typeof input.assigneeId !== 'string' || (input.assignmentNote !== undefined && typeof input.assignmentNote !== 'string') || Object.keys(input).some((key) => !['action', 'taskId', 'assigneeId', 'assignmentNote'].includes(key))) {
                throw new Error('Kanban control requires either delete with taskId, or assign with taskId, assigneeId, and an optional assignmentNote.');
              }
              return { kind: 'json', status: 202, body: { task: (await service.assignTask(input.taskId, input.assigneeId, input.assignmentNote)).task } };
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
