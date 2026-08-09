import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { StudioAgent, StudioContext } from './petAgentTypes';
import { createPlanCapability, createPlanToolkit } from './planCapability';
import type { StudioPlanPetListItem } from './planCapability';
import type {
  PetAgentRuntime,
  PetAgentRuntimeDescriptor,
  StudioOrchestrator,
  StudioOrchestratorConfig,
  StudioQueueItem,
  StudioRunSnapshot,
  StudioRunEvent,
  StudioRunEventHandler,
  StudioRunStatus,
  StudioSubmitRequestInput,
  StudioSubmitRequestResult,
  StudioTaskDependencyInput,
  StudioTaskStatus,
  StudioTurnEvent,
  StudioTurnEventHandler,
  StudioTurnOutcome,
  StudioTurnResult,
} from './types';
import { createNoopWikiCurator, noopWikiSkeletonInitializer } from './wikiPort';
import type { WikiCurator } from './wikiPort';

const DEFAULT_MAX_ITERATION_COUNT = 32;
const DEFAULT_MAX_RETRY_PER_TASK = 2;

type StudioQueuedTaskInput = {
  petId: string;
  goal: string;
  acceptanceCriteria: string[];
  deps?: StudioTaskDependencyInput[];
};

type StudioQueuedTaskBatch = {
  tasks: StudioQueuedTaskInput[];
};

type QueuedTaskRuntimeState = {
  status: StudioTaskStatus;
  retryCount: number;
};

function toStudioAgent(descriptor: PetAgentRuntimeDescriptor): StudioAgent {
  return {
    petId: descriptor.petId,
    userId: descriptor.userId,
    name: descriptor.name,
    personality: descriptor.personality,
    stage: descriptor.stage,
    species: descriptor.species,
    role: descriptor.role ?? null,
    serviceSummary: descriptor.serviceSummary ?? null,
    startupMode: descriptor.startupMode,
    status: descriptor.status,
    capabilities: descriptor.capabilities,
  };
}

function toPlanPetListItem(descriptor: PetAgentRuntimeDescriptor): StudioPlanPetListItem {
  return {
    petId: descriptor.petId,
    role: descriptor.role ?? null,
    serviceSummary: descriptor.serviceSummary ?? null,
    status: descriptor.status,
  };
}

function isDispatchable(descriptor: PetAgentRuntimeDescriptor): boolean {
  return (
    descriptor.startupMode !== 'disabled'
    && (descriptor.status === 'standby' || descriptor.status === 'degraded')
  );
}

function createStudioPetRegistry(agents: PetAgentRuntime[]): {
  getRuntime: (petId: string) => PetAgentRuntime | undefined;
  listDescriptors: () => PetAgentRuntimeDescriptor[];
  listPlanningPets: () => StudioPlanPetListItem[];
  isDispatchable: (petId: string) => boolean;
} {
  const agentsByPetId = new Map<string, PetAgentRuntime>();
  for (const agent of agents) {
    const descriptor = agent.descriptor();
    if (agentsByPetId.has(descriptor.petId)) {
      throw new Error(`Duplicate pet agent id in studio: ${descriptor.petId}`);
    }
    agentsByPetId.set(descriptor.petId, agent);
  }

  function getRuntime(petId: string): PetAgentRuntime | undefined {
    return agentsByPetId.get(petId);
  }

  function listDescriptors(): PetAgentRuntimeDescriptor[] {
    return agents.map((agent) => agent.descriptor());
  }

  function listPlanningPets(): StudioPlanPetListItem[] {
    return listDescriptors().map(toPlanPetListItem);
  }

  function isRuntimeDispatchable(petId: string): boolean {
    const agent = getRuntime(petId);
    return agent ? isDispatchable(agent.descriptor()) : false;
  }

  return {
    getRuntime,
    listDescriptors,
    listPlanningPets,
    isDispatchable: isRuntimeDispatchable,
  };
}

function buildWikiRoot(baseDir: string, conversationId: string): string {
  return path.resolve(baseDir, 'conv', conversationId, 'wiki');
}

function normalizeQueuedTaskBatch(batch: StudioQueuedTaskBatch): StudioQueuedTaskBatch {
  return {
    tasks: batch.tasks.map((task) => ({
      petId: task.petId,
      goal: task.goal,
      acceptanceCriteria: task.acceptanceCriteria ?? [],
      deps: task.deps ?? [],
    })),
  };
}

function buildInitialTaskStates(batch: StudioQueuedTaskBatch): QueuedTaskRuntimeState[] {
  return batch.tasks.map(() => ({
    status: 'pending',
    retryCount: 0,
  }));
}

function buildTaskStatesFromSnapshot(tasks: StudioQueueItem[]): QueuedTaskRuntimeState[] {
  return tasks
    .sort((a, b) => a.taskIndex - b.taskIndex)
    .map((task) => ({
      // FileStudioRunQueueStore normalizes recovered running tasks to failed.
      // Treat any other terminal persisted status as failed here as a defensive fallback.
      status: task.status === 'done'
        ? 'satisfied'
        : task.status === 'queued'
          ? 'pending'
          : 'failed',
      retryCount: task.status === 'failed' ? DEFAULT_MAX_RETRY_PER_TASK : 0,
    }));
}

function buildTaskBatchFromSnapshot(tasks: StudioQueueItem[]): StudioQueuedTaskBatch | null {
  if (tasks.length === 0) {
    return null;
  }
  return {
    tasks: tasks
      .sort((a, b) => a.taskIndex - b.taskIndex)
      .map((task) => ({
        petId: task.petId,
        goal: task.brief,
        acceptanceCriteria: task.acceptanceCriteria,
        deps: task.deps.map((taskIndex) => ({ taskIndex })),
      })),
  };
}

/**
 * 把可选的 onTurnEvent 包成一个稳定的同步可调用对象。
 * 不 await — handler 若返回 promise,Studio 不阻塞编排。
 * handler 抛错也不影响主流程。
 */
function makeEmitter(handler: StudioTurnEventHandler | undefined): (event: StudioTurnEvent) => void {
  if (!handler) return () => {};
  return (event) => {
    try {
      const ret = handler(event);
      if (ret && typeof (ret as Promise<void>).catch === 'function') {
        (ret as Promise<void>).catch(() => {});
      }
    } catch {
      // 不让 handler 抛错影响 turn
    }
  };
}

type StudioRunRecord = {
  turnId: string;
  conversationId: string;
  userRequest: string;
  signal?: AbortSignal;
  abortController: AbortController;
  emit: (event: StudioTurnEvent) => void;
  state: StudioRunInternalState;
  taskResults: Map<number, string>;
  status: StudioRunStatus;
  createdAt: string;
  updatedAt: string;
  outcome: StudioTurnOutcome | null;
  resultPromise: Promise<StudioTurnResult>;
  resolve: (result: StudioTurnResult) => void;
  reject: (error: unknown) => void;
};

type StudioRunInternalState = {
  turnId: string;
  conversationId: string;
  userRequest: string;
  taskBatch: StudioQueuedTaskBatch | null;
  taskStates: QueuedTaskRuntimeState[];
  wikiRoot: string;
  iterationCount: number;
};

type StudioWorkerHandoffInput = {
  taskIndex: number;
  brief: string;
};

type StudioWorkerRunResult = {
  petRunId: string;
  status: 'finished' | 'cancelled';
  resultText?: string;
  errorMessage?: string;
  finishedAt?: string;
};

function createDeferredTurnResult(): {
  resultPromise: Promise<StudioTurnResult>;
  resolve: (result: StudioTurnResult) => void;
  reject: (error: unknown) => void;
} {
  let resolveRun!: (result: StudioTurnResult) => void;
  let rejectRun!: (error: unknown) => void;
  const resultPromise = new Promise<StudioTurnResult>((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });
  resultPromise.catch(() => {});
  return {
    resultPromise,
    resolve: resolveRun,
    reject: rejectRun,
  };
}

function createRunAbortController(externalSignal: AbortSignal | undefined): AbortController {
  const controller = new AbortController();
  if (!externalSignal) {
    return controller;
  }
  if (externalSignal.aborted) {
    controller.abort(externalSignal.reason);
    return controller;
  }
  externalSignal.addEventListener('abort', () => {
    controller.abort(externalSignal.reason);
  }, { once: true });
  return controller;
}

function runStatusForOutcome(outcome: StudioTurnOutcome): StudioRunStatus {
  if (outcome.outcome === 'done') {
    return 'done';
  }
  return outcome.reason === 'aborted by signal' ? 'cancelled' : 'failed';
}

function toStudioRun(record: StudioRunRecord, tasks: StudioQueueItem[]): StudioRunSnapshot {
  const doneTasks = tasks.filter((task) => task.status === 'done' && task.petRunId);
  const finalTask = doneTasks[doneTasks.length - 1];
  return {
    runId: record.turnId,
    conversationId: record.conversationId,
    userRequest: record.userRequest,
    status: record.status,
    finalTaskIndex: finalTask?.taskIndex,
    finalPetRunId: finalTask?.petRunId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    tasks,
  };
}

function buildTerminalOutcomeIfReady(record: StudioRunRecord, tasks: StudioQueueItem[]): StudioTurnOutcome | null {
  if (!record.state.taskBatch) {
    return null;
  }
  const hasOpenTask = tasks.some((task) => task.status === 'queued' || task.status === 'running');
  if (hasOpenTask) {
    return null;
  }
  const finalTask = tasks
    .filter((task) => task.status === 'done' && task.petRunId)
    .at(-1);
  if (finalTask?.petRunId) {
    return {
      outcome: 'done',
      finalTaskIndex: finalTask.taskIndex,
      finalPetRunId: finalTask.petRunId,
      reply: record.taskResults.get(finalTask.taskIndex) ?? '',
    };
  }
  return {
    outcome: 'stopped',
    reason: 'all queued tasks failed, no deliverable output',
    reply: '',
  };
}


export function createStudioOrchestrator(config: StudioOrchestratorConfig): StudioOrchestrator {
  const petRegistry = createStudioPetRegistry(config.agents);

  const maxIterationCount = config.maxIterationCount ?? DEFAULT_MAX_ITERATION_COUNT;
  const maxRetryPerTask = config.maxRetryPerTask ?? DEFAULT_MAX_RETRY_PER_TASK;
  const curator: WikiCurator = config.curator ?? createNoopWikiCurator();
  const ensureWikiSkeleton = config.ensureWikiSkeleton ?? noopWikiSkeletonInitializer;
  const runQueueStore = config.runQueueStore;
  const queue: StudioQueueItem[] = [];
  const runs = new Map<string, StudioRunRecord>();
  const runEventHandlers = new Set<StudioRunEventHandler>();
  const activePets = new Set<string>();
  let scheduling = false;

  function listAgents(): PetAgentRuntimeDescriptor[] {
    return petRegistry.listDescriptors();
  }

  function context(): StudioContext {
    return {
      studioId: config.studioId,
      ownerUserId: config.ownerUserId,
      defaultPetId: config.defaultPetId ?? null,
      agents: listAgents().map(toStudioAgent),
    };
  }

  function createRunRecord(params: {
    turnId: string;
    conversationId: string;
    userRequest: string;
    signal?: AbortSignal;
    onTurnEvent?: StudioTurnEventHandler;
    status: StudioRunStatus;
    createdAt: string;
    updatedAt: string;
    taskBatch?: StudioQueuedTaskBatch | null;
    taskStates?: QueuedTaskRuntimeState[];
    iterationCount?: number;
  }): StudioRunRecord {
    const deferred = createDeferredTurnResult();
    return {
      turnId: params.turnId,
      conversationId: params.conversationId,
      userRequest: params.userRequest,
      signal: params.signal,
      abortController: createRunAbortController(params.signal),
      emit: makeEmitter(params.onTurnEvent),
      state: {
        turnId: params.turnId,
        conversationId: params.conversationId,
        userRequest: params.userRequest,
        taskBatch: params.taskBatch ?? null,
        taskStates: params.taskStates ?? [],
        wikiRoot: buildWikiRoot(config.wikiBaseDir, params.conversationId),
        iterationCount: params.iterationCount ?? 0,
      },
      taskResults: new Map(),
      status: params.status,
      createdAt: params.createdAt,
      updatedAt: params.updatedAt,
      outcome: null,
      resultPromise: deferred.resultPromise,
      resolve: deferred.resolve,
      reject: deferred.reject,
    };
  }

  async function runDispatch(
    state: StudioRunInternalState,
    action: StudioWorkerHandoffInput,
    dispatchId: string,
    signal: AbortSignal | undefined,
    emit: (event: StudioTurnEvent) => void,
  ): Promise<StudioWorkerRunResult> {
    if (!state.taskBatch) {
      throw new Error('worker handoff called without queued task batch');
    }
    const task = state.taskBatch.tasks[action.taskIndex];
    const taskState = state.taskStates[action.taskIndex];
    if (!task) {
      throw new Error(`task at index ${action.taskIndex} not found in queued task batch`);
    }
    if (!taskState) {
      throw new Error(`task runtime state at index ${action.taskIndex} not found`);
    }
    const taskIndex = action.taskIndex;

    function changeTaskStatus(nextStatus: QueuedTaskRuntimeState['status']): void {
      taskState.status = nextStatus;
      emit({ type: 'task_status_changed', taskIndex, status: nextStatus });
    }

    const agent = petRegistry.getRuntime(task.petId);
    const workerRun: StudioWorkerRunResult = {
      petRunId: dispatchId,
      status: 'finished',
    };
    emit({ type: 'task_started', taskIndex, petId: task.petId, petRunId: dispatchId });

    if (!agent) {
      workerRun.status = 'cancelled';
      workerRun.errorMessage = `agent_not_found:${task.petId}`;
      workerRun.finishedAt = new Date().toISOString();
      changeTaskStatus('failed');
      emit({
        type: 'task_finished',
        taskIndex,
        petId: task.petId,
        petRunId: dispatchId,
        status: 'cancelled',
        errorMessage: workerRun.errorMessage,
      });
      return workerRun;
    }

    const descriptor = agent.descriptor();
    if (!petRegistry.isDispatchable(task.petId)) {
      workerRun.status = 'cancelled';
      workerRun.errorMessage = `agent_not_dispatchable:${descriptor.status}`;
      workerRun.finishedAt = new Date().toISOString();
      changeTaskStatus('failed');
      emit({
        type: 'task_finished',
        taskIndex,
        petId: task.petId,
        petRunId: dispatchId,
        status: 'cancelled',
        errorMessage: workerRun.errorMessage,
      });
      return workerRun;
    }

    try {
      const result = await agent.invoke({
        brief: action.brief,
        wikiRoot: state.wikiRoot,
        signal,
        threadId: `studio:${config.studioId}:thread:${state.conversationId}:pet:${task.petId}:dispatch:${dispatchId}`,
        workdir: config.workdir,
      });
      workerRun.status = 'finished';
      workerRun.resultText = result.reply;
      workerRun.finishedAt = new Date().toISOString();
      changeTaskStatus('satisfied');
    } catch (error) {
      workerRun.status = 'finished';
      workerRun.errorMessage = error instanceof Error ? error.message : String(error);
      workerRun.finishedAt = new Date().toISOString();
      taskState.retryCount += 1;
      if (taskState.retryCount >= maxRetryPerTask) {
        changeTaskStatus('failed');
      }
    }

    emit({
      type: 'task_finished',
      taskIndex,
      petId: task.petId,
      petRunId: dispatchId,
      status: workerRun.status,
      resultText: workerRun.resultText,
      errorMessage: workerRun.errorMessage,
    });

    return workerRun;
  }

  async function obtainTaskBatch(params: {
    userRequest: string;
    wikiRoot: string;
    signal?: AbortSignal;
    conversationId: string;
  }): Promise<{ taskBatch: StudioQueuedTaskBatch | null; plannerReply: string | null }> {
    const planner = petRegistry.getRuntime(config.plannerPetId);
    if (!planner) {
      throw new Error(`plannerPetId "${config.plannerPetId}" not found in registered agents`);
    }
    let capturedTaskBatch: StudioQueuedTaskBatch | null = null;
    const planToolkit = createPlanToolkit({
      enqueueTasks: (tasks) => {
        capturedTaskBatch = normalizeQueuedTaskBatch({
          tasks: tasks.map((task) => ({
            petId: task.petId,
            goal: task.brief,
            acceptanceCriteria: task.acceptanceCriteria ?? [],
            deps: task.deps ?? [],
          })),
        });
      },
      listPets: petRegistry.listPlanningPets,
    });
    const planCapability = createPlanCapability();

    const result = await planner.invoke({
      brief: params.userRequest,
      wikiRoot: params.wikiRoot,
      signal: params.signal,
      threadId: `studio:${config.studioId}:thread:${params.conversationId}:planner`,
      workdir: config.workdir,
      extraCapabilities: [planCapability],
      toolkits: [planToolkit],
      // Studio planning run exposes only its dedicated planning Capability.
      // The framework-internal Capability Planner still explores that
      // Capability's document and owns the concrete selection.
      allowedCapabilityNames: [planCapability.name],
    });

    return { taskBatch: capturedTaskBatch, plannerReply: result.reply };
  }

  function setRunStatus(record: StudioRunRecord, status: StudioRunStatus): void {
    record.status = status;
    record.updatedAt = new Date().toISOString();
  }

  function readRunSnapshot(record: StudioRunRecord): StudioRunSnapshot {
    const tasks = queue
      .filter((item) => item.runId === record.turnId)
      .map((item) => ({ ...item }));
    return toStudioRun(record, tasks);
  }

  function saveRunSnapshot(record: StudioRunRecord): void {
    runQueueStore?.save(readRunSnapshot(record));
  }

  function emitRunEvent(record: StudioRunRecord, event: StudioTurnEvent): void {
    record.emit(event);
    saveRunSnapshot(record);
    const runEvent: StudioRunEvent = event.type === 'wiki_updated'
      ? {
          type: 'wiki_changed',
          runId: record.turnId,
          conversationId: record.conversationId,
          changedPaths: event.changedPaths,
          occurredAt: new Date().toISOString(),
        }
      : {
          type: 'run_changed',
          runId: record.turnId,
          conversationId: record.conversationId,
          status: record.status,
          snapshot: readRunSnapshot(record),
          reason: event.type === 'turn_finished' && event.outcome === 'stopped'
            ? 'stopped'
            : undefined,
          occurredAt: new Date().toISOString(),
        };
    for (const handler of runEventHandlers) {
      try {
        const ret = handler(runEvent);
        if (ret && typeof (ret as Promise<void>).catch === 'function') {
          (ret as Promise<void>).catch(() => {});
        }
      } catch {
        // event subscribers must not affect runner progress
      }
    }
  }

  function completeRun(record: StudioRunRecord, outcome: StudioTurnOutcome): void {
    if (record.outcome) {
      return;
    }
    record.outcome = outcome;
    setRunStatus(record, runStatusForOutcome(outcome));
    saveRunSnapshot(record);
    emitRunEvent(record, {
      type: 'turn_finished',
      outcome: outcome.outcome,
      ...(outcome.outcome === 'done' ? { finalPetRunId: outcome.finalPetRunId } : {}),
    });
    const snapshot = readRunSnapshot(record);
    record.resolve({
      turnId: record.turnId,
      snapshot,
      outcome,
      studio: context(),
    });
  }

  function failRun(record: StudioRunRecord, error: unknown): void {
    if (record.outcome) {
      return;
    }
    if (record.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      completeRun(record, {
        outcome: 'stopped',
        reason: 'aborted by signal',
        reply: '',
      });
      return;
    }
    record.outcome = {
      outcome: 'stopped',
      reason: error instanceof Error ? error.message : String(error),
      reply: '',
    };
    setRunStatus(record, 'failed');
    saveRunSnapshot(record);
    emitRunEvent(record, {
      type: 'turn_finished',
      outcome: 'stopped',
    });
    record.reject(error);
  }

  function normalizeDepsForTask(batch: StudioQueuedTaskBatch, taskIndex: number): number[] {
    const task = batch.tasks[taskIndex];
    const deps = task.deps ?? [];
    const normalized = new Set<number>();
    for (const dep of deps) {
      const depIndex = dep === 'previous' ? taskIndex - 1 : dep.taskIndex;
      if (depIndex < 0 || depIndex >= taskIndex) {
        throw new Error(`invalid task dependency for task ${taskIndex}: ${JSON.stringify(dep)}`);
      }
      normalized.add(depIndex);
    }
    return [...normalized].sort((a, b) => a - b);
  }

  function enqueueTaskBatch(record: StudioRunRecord, batch: StudioQueuedTaskBatch): void {
    record.state.taskBatch = batch;
    record.state.taskStates = buildInitialTaskStates(batch);
    saveRunSnapshot(record);

    if (batch.tasks.length === 0) {
      completeRun(record, {
        outcome: 'stopped',
        reason: 'planner submitted empty task batch',
        reply: '(stopped: planner submitted empty task batch)',
      });
      return;
    }

    for (const [taskIndex, task] of batch.tasks.entries()) {
      queue.push({
        runId: record.turnId,
        conversationId: record.conversationId,
        taskIndex,
        petId: task.petId,
        brief: task.goal,
        acceptanceCriteria: task.acceptanceCriteria,
        deps: normalizeDepsForTask(batch, taskIndex),
        status: 'queued',
        enqueuedAt: new Date().toISOString(),
      });
    }
    setRunStatus(record, 'running');
    saveRunSnapshot(record);
    emitRunEvent(record, { type: 'tasks_queued', taskCount: batch.tasks.length });
    scheduleQueue();
  }

  async function startPlanning(record: StudioRunRecord): Promise<void> {
    try {
      emitRunEvent(record, { type: 'turn_started', turnId: record.turnId, userRequest: record.userRequest });
      setRunStatus(record, 'planning');
      saveRunSnapshot(record);
      if (record.signal?.aborted) {
        completeRun(record, {
          outcome: 'stopped',
          reason: 'aborted by signal',
          reply: '',
        });
        return;
      }

      const { taskBatch, plannerReply } = await obtainTaskBatch({
        userRequest: record.userRequest,
        wikiRoot: record.state.wikiRoot,
        signal: record.signal,
        conversationId: record.conversationId,
      });

      if (record.outcome) {
        return;
      }

      if (!taskBatch) {
        const reason = plannerReply
          ? `planner did not enqueue tasks: ${plannerReply}`
          : 'planner did not enqueue tasks';
        completeRun(record, {
          outcome: 'stopped',
          reason,
          reply: plannerReply ?? `(stopped: ${reason})`,
        });
        return;
      }

      enqueueTaskBatch(record, taskBatch);
    } catch (error) {
      failRun(record, error);
    }
  }

  function dependenciesDone(item: StudioQueueItem): boolean {
    const record = runs.get(item.runId);
    if (!record) {
      return false;
    }
    return item.deps.every((depIndex) => {
      const dep = queue.find((candidate) => (
        candidate.runId === item.runId
        && candidate.taskIndex === depIndex
      ));
      return dep?.status === 'done';
    });
  }

  function finishTaskIfRunTerminal(record: StudioRunRecord): void {
    const tasks = queue.filter((item) => item.runId === record.turnId);
    const terminalOutcome = buildTerminalOutcomeIfReady(record, tasks);
    if (terminalOutcome) {
      completeRun(record, terminalOutcome);
    }
  }

  function dispatchQueuedTask(item: StudioQueueItem, record: StudioRunRecord): void {
    const taskState = record.state.taskStates[item.taskIndex];
    if (!taskState || taskState.status !== 'pending') {
      return;
    }
    if (record.signal?.aborted) {
      item.status = 'cancelled';
      item.finishedAt = new Date().toISOString();
      saveRunSnapshot(record);
      completeRun(record, {
        outcome: 'stopped',
        reason: 'aborted by signal',
        reply: '',
      });
      return;
    }
    if (record.state.iterationCount >= maxIterationCount) {
      item.status = 'failed';
      item.finishedAt = new Date().toISOString();
      saveRunSnapshot(record);
      completeRun(record, {
        outcome: 'stopped',
        reason: `max iteration count ${maxIterationCount} reached`,
        reply: '',
      });
      return;
    }

    item.status = 'running';
    item.startedAt = new Date().toISOString();
    item.petRunId = randomUUID().slice(0, 8);
    activePets.add(item.petId);
    record.state.iterationCount += 1;
    saveRunSnapshot(record);

    void runDispatch(
      record.state,
      { taskIndex: item.taskIndex, brief: item.brief },
      item.petRunId,
      record.signal,
      (event) => emitRunEvent(record, event),
    ).then(async (workerRun) => {
      item.errorMessage = workerRun.errorMessage;
      item.finishedAt = workerRun.finishedAt ?? new Date().toISOString();
      const resultText = workerRun.resultText;
      if (record.signal?.aborted) {
        item.status = 'cancelled';
        completeRun(record, {
          outcome: 'stopped',
          reason: 'aborted by signal',
          reply: workerRun.resultText ?? '',
        });
      } else if (taskState.status === 'pending') {
        item.status = 'queued';
        item.startedAt = undefined;
      } else if (taskState.status === 'satisfied') {
        item.status = 'done';
        if (typeof resultText === 'string') {
          record.taskResults.set(item.taskIndex, resultText);
        }
      } else {
        item.status = 'failed';
      }
      saveRunSnapshot(record);

      if (item.status === 'done' || item.status === 'failed') {
        try {
          const curateResult = await curator.curate({
            wikiRoot: record.state.wikiRoot,
            task: {
              ...item,
              resultText,
            },
          });
          if (curateResult.changedPaths.length > 0) {
            emitRunEvent(record, { type: 'wiki_updated', changedPaths: curateResult.changedPaths });
          }
        } catch (curatorError) {
          item.errorMessage = item.errorMessage
            ?? `wiki_curator_failed:${(curatorError as Error).message}`;
          saveRunSnapshot(record);
        }
      }

      activePets.delete(item.petId);
      finishTaskIfRunTerminal(record);
      scheduleQueue();
    }).catch((error) => {
      activePets.delete(item.petId);
      item.status = 'failed';
      item.errorMessage = error instanceof Error ? error.message : String(error);
      item.finishedAt = new Date().toISOString();
      saveRunSnapshot(record);
      failRun(record, error);
      scheduleQueue();
    });
  }

  function scheduleQueue(): void {
    if (scheduling) {
      return;
    }
    scheduling = true;
    try {
      while (true) {
        const item = queue.find((candidate) => candidate.status === 'queued');
        if (!item) {
          return;
        }
        const record = runs.get(item.runId);
        if (!record || record.outcome) {
          item.status = 'cancelled';
          item.finishedAt = new Date().toISOString();
          if (record) {
            saveRunSnapshot(record);
          }
          continue;
        }
        if (!dependenciesDone(item)) {
          return;
        }
        if (!petRegistry.isDispatchable(item.petId) || activePets.has(item.petId)) {
          // Current iteration keeps strict global FIFO: a blocked head item stops this
          // scheduling pass even if later runs have ready work. Task completion or a new
          // enqueue triggers another pass; cross-run fairness is a later scheduler concern.
          setRunStatus(record, 'blocked');
          saveRunSnapshot(record);
          return;
        }
        if (record.status === 'blocked') {
          setRunStatus(record, 'running');
          saveRunSnapshot(record);
        }
        dispatchQueuedTask(item, record);
      }
    } finally {
      scheduling = false;
    }
  }

  async function submitRequest(input: StudioSubmitRequestInput): Promise<StudioSubmitRequestResult> {
    const turnId = input.turnId ?? randomUUID();
    const conversationId = input.conversationId ?? turnId;
    const wikiRoot = buildWikiRoot(config.wikiBaseDir, conversationId);
    await ensureWikiSkeleton(wikiRoot);
    const abortController = createRunAbortController(input.signal);

    const createdAt = new Date().toISOString();
    const record = createRunRecord({
      turnId,
      conversationId,
      userRequest: input.userRequest,
      signal: abortController.signal,
      onTurnEvent: input.onTurnEvent,
      status: 'planning',
      createdAt,
      updatedAt: createdAt,
    });
    runs.set(turnId, record);
    void startPlanning(record);

    return { runId: turnId, status: 'accepted' };
  }

  function getRun(runId: string): StudioRunSnapshot | null {
    const record = runs.get(runId);
    if (!record) {
      return null;
    }
    return readRunSnapshot(record);
  }

  function subscribe(handler: StudioRunEventHandler): () => void {
    runEventHandlers.add(handler);
    return () => {
      runEventHandlers.delete(handler);
    };
  }

  async function cancelRun(runId: string): Promise<void> {
    const record = runs.get(runId);
    if (!record) {
      throw new Error(`studio run "${runId}" was not registered`);
    }
    if (record.outcome) {
      return;
    }
    record.abortController.abort(new Error('cancelled by caller'));
    const cancelledAt = new Date().toISOString();
    for (const item of queue) {
      if (item.runId === runId && (item.status === 'queued' || item.status === 'running')) {
        item.status = 'cancelled';
        item.finishedAt = cancelledAt;
      }
    }
    completeRun(record, {
      outcome: 'stopped',
      reason: 'aborted by signal',
      reply: '',
    });
  }

  async function waitForRun(runId: string): Promise<StudioTurnResult> {
    const record = runs.get(runId);
    if (!record) {
      throw new Error(`studio run "${runId}" was not registered`);
    }
    return await record.resultPromise;
  }

  function restoreOpenRunsFromStore(): void {
    if (!runQueueStore || config.restoreOpenRuns === false) {
      return;
    }
    const recovered = runQueueStore.recoverOpenRuns();
    for (const snapshot of recovered) {
      if (runs.has(snapshot.runId)) {
        continue;
      }
      const tasks = snapshot.tasks.map((task) => ({ ...task }));
      const taskBatch = buildTaskBatchFromSnapshot(tasks);
      const record = createRunRecord({
        turnId: snapshot.runId,
        conversationId: snapshot.conversationId,
        userRequest: snapshot.userRequest,
        status: snapshot.status,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
        taskBatch,
        taskStates: buildTaskStatesFromSnapshot(tasks),
        iterationCount: tasks.filter((task) => task.status !== 'queued').length,
      });
      runs.set(snapshot.runId, record);
      queue.push(...tasks);
      saveRunSnapshot(record);
      if (snapshot.status === 'planning' && tasks.length === 0) {
        void (async () => {
          await ensureWikiSkeleton(record.state.wikiRoot);
          await startPlanning(record);
        })().catch((error) => {
          failRun(record, error);
        });
      }
      finishTaskIfRunTerminal(record);
    }
    scheduleQueue();
  }

  restoreOpenRunsFromStore();

  return {
    context,
    listAgents,
    submitRequest,
    subscribe,
    cancelRun,
    getRun,
    waitForRun,
  };
}
