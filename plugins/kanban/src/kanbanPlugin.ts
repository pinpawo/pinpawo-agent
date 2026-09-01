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
export const KANBAN_PLANNING_TOOLKIT_NAME = 'kanban-planning';
export const KANBAN_EXECUTION_TOOLKIT_NAME = 'kanban-execution';
export const KANBAN_OBSERVATION_TOOLKIT_NAME = 'kanban-observation';

const TOOL_TITLES = ['查看执行者', '查看任务', '新增任务', '完成任务', '阻塞任务'] as const;

function describeTask(task: KanbanTask): string {
  const deps = task.deps.length > 0 ? ` deps=[${task.deps.join(', ')}]` : '';
  const note = task.note ? ` note=${task.note}` : '';
  return [
    `${task.taskId} [${task.status}] assignee=${task.assigneeId}${deps} title=${task.title}${note}`,
    `detail=${task.detail}`,
  ].join('\n');
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
    `Title: ${task.title}`,
    '',
    task.detail,
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
      description: '读取当前 Kanban task 快照，返回每个 task 的状态、执行者、依赖、详情与已有结果。',
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
        title: input.title,
        detail: input.detail,
        ...(input.dependsOn ? { dependsOn: input.dependsOn } : {}),
      });
      return `added ${mutation.task.taskId}`;
    },
    {
      name: 'kanban_task_add',
      description:
        '创建并指派一个由接收 Pet 直接完成的最终交付 task。一次调用只创建一个 task；'
        + 'dependsOn 表示真实的交付依赖，依赖完成后进入可派发状态。返回的 taskId 是持久化成功的确认。',
      schema: z.object({
        petId: z.string().describe('负责完整交付的 Studio petId'),
        title: z.string().max(160).describe('便于在看板列表识别任务的简短标题，只表达该 task 的完整交付主题'),
        detail: z.string().describe('接收方的完整任务详情，包含目标、完成标准、必要上下文与应保留的证据'),
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
  /** Optional Studio Pet ids that may receive Kanban tasks. Defaults to every registered Pet. */
  assignablePetIds?: readonly string[];
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

export function createKanbanPlanningToolkit(
  service: KanbanTaskService,
  readAssignees: () => readonly StudioPetRegistration[] | null = () => null,
): AgentToolkit {
  const declaredTools = buildTools(service, readAssignees).slice(0, 3);
  return {
    name: KANBAN_PLANNING_TOOLKIT_NAME,
    description: 'Studio 的 task 规划接口：读取可分派 Pet 与当前 task 图，并登记新的完整交付及其依赖。',
    tools: declaredTools.map((declared, index) => ({
      tool: declared,
      operation: { title: TOOL_TITLES[index] ?? declared.name },
    })),
  };
}

export function createKanbanExecutionToolkit(
  service: KanbanTaskService,
  readAssignees: () => readonly StudioPetRegistration[] | null = () => null,
): AgentToolkit {
  const declaredTools = buildTools(service, readAssignees);
  const executionTools = [declaredTools[1], declaredTools[3], declaredTools[4]].filter(
    (declared): declared is NamedStructuredTool => Boolean(declared),
  );
  const titles = ['查看任务', '完成任务', '阻塞任务'];
  return {
    name: KANBAN_EXECUTION_TOOLKIT_NAME,
    description: 'Studio 的 task 执行回报接口：读取已分派 task，并提交完成结果或明确阻塞。',
    tools: executionTools.map((declared, index) => ({
      tool: declared,
      operation: { title: titles[index] ?? declared.name },
    })),
  };
}

export function createKanbanObservationToolkit(
  service: KanbanTaskService,
  readAssignees: () => readonly StudioPetRegistration[] | null = () => null,
): AgentToolkit {
  const listTasks = buildTools(service, readAssignees)[1];
  if (!listTasks) throw new Error('Kanban task observation tool is unavailable.');
  return {
    name: KANBAN_OBSERVATION_TOOLKIT_NAME,
    description: 'Studio 的只读 task 观察接口：读取当前 task 图、执行状态、依赖和已提交结果。',
    tools: [{
      tool: listTasks,
      operation: { title: '查看任务' },
    }],
  };
}

export function createKanbanPlugin(options: CreateKanbanPluginOptions = {}): KanbanPlugin {
  const assignablePetIds = options.assignablePetIds?.map((petId) => petId.trim());
  if (assignablePetIds) {
    if (assignablePetIds.length === 0 || assignablePetIds.some((petId) => !petId)) {
      throw new Error('Kanban assignablePetIds must contain at least one non-empty Studio petId.');
    }
    if (new Set(assignablePetIds).size !== assignablePetIds.length) {
      throw new Error('Kanban assignablePetIds must not contain duplicate Studio petIds.');
    }
  }
  const ownsService = !options.service;
  const service = options.service ?? (options.databasePath
    ? new KanbanTaskService(new SqliteKanbanTaskRepository(options.databasePath))
    : createInMemoryKanbanTaskService());
  let assignees: readonly StudioPetRegistration[] | null = null;
  const toolkit = createKanbanToolkit(service, () => assignees);
  const planningToolkit = createKanbanPlanningToolkit(service, () => assignees);
  const executionToolkit = createKanbanExecutionToolkit(service, () => assignees);
  const observationToolkit = createKanbanObservationToolkit(service, () => assignees);
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
      const activeAssigneeIds = new Set(
        (await service.readSnapshot()).tasks.filter(isActive).map(({ assigneeId }) => assigneeId),
      );
      while (dispatchEnabled && context) {
        const mutation = await service.claimNextReadyTask([...activeAssigneeIds]);
        if (!mutation) break;
        activeAssigneeIds.add(mutation.task.assigneeId);
        await dispatchClaimedTask(mutation.task).catch(() => undefined);
      }
    }
  }

  async function startTask(taskId: string): Promise<KanbanTask> {
    const snapshot = await service.readSnapshot();
    const target = snapshot.tasks.find((task) => task.taskId === taskId);
    if (!target) throw new Error(`Kanban task "${taskId}" does not exist.`);
    const active = snapshot.tasks.find((task) => (
      task.assigneeId === target.assigneeId && task.taskId !== taskId && isActive(task)
    ));
    if (active) {
      throw new Error(
        `Studio Pet "${target.assigneeId}" is already working on task "${active.taskId}".`,
      );
    }
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
    toolkits: [toolkit, planningToolkit, executionToolkit, observationToolkit],
    start: async (pluginContext) => {
      if (context) throw new Error('Kanban Plugin is already started.');
      context = pluginContext;
      try {
        const registeredPets = pluginContext.listPets();
        const registeredById = new Map(registeredPets.map((registration) => (
          [registration.petId, registration]
        )));
        const configuredAssignees = assignablePetIds?.map((petId) => {
          const registration = registeredById.get(petId);
          if (!registration) {
            throw new Error(`Kanban assignable petId "${petId}" is not registered in this Studio.`);
          }
          return registration;
        });
        assignees = configuredAssignees ?? registeredPets;
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
  const allowed = new Set(['databasePath', 'httpRoute', 'dispatchMode', 'assignablePetIds']);
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
  if (options.assignablePetIds !== undefined && (
    !Array.isArray(options.assignablePetIds)
    || options.assignablePetIds.length === 0
    || options.assignablePetIds.some((petId) => typeof petId !== 'string')
  )) {
    throw new Error('Kanban Plugin option "assignablePetIds" must be a non-empty string array.');
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
    ...(options.assignablePetIds === undefined
      ? {}
      : { assignablePetIds: options.assignablePetIds as string[] }),
    ...(httpRoute !== undefined
      ? { httpRoute: httpRoute as CreateKanbanPluginOptions['httpRoute'] }
      : {}),
  });
}
