import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  InMemoryStudioRunQueueStore,
  OPEN_RUN_STATUSES,
  cloneSnapshot,
  recoverSnapshot,
  runFromSnapshot,
  snapshotFromRun,
  sortSnapshots,
  type StudioRunQueueStore,
  type StudioRunQueueStoreRecoveryOptions,
  type StudioRunQueueStoreState,
  type StudioRun,
  type StudioInvocation,
  type StudioRunSnapshot,
  type StudioRunStatus,
  type StudioTaskQueueItem,
} from '@pinpawo/studio';

type StoredStudioRun = StudioRun;

export class FileStudioRunQueueStore implements StudioRunQueueStore {
  private readonly runtimeStore = new InMemoryStudioRunQueueStore();
  private readonly filePath: string;

  constructor(options: { filePath: string }) {
    this.filePath = options.filePath;
    this.syncFromDisk();
  }

  clear(): void {
    this.runtimeStore.clear();
    this.syncToDisk();
  }

  save(snapshot: StudioRunSnapshot): StudioRunSnapshot {
    this.syncFromDisk();
    const saved = this.runtimeStore.save(snapshot);
    this.syncToDisk();
    return saved;
  }

  get(runId: string): StudioRunSnapshot | null {
    this.syncFromDisk();
    return this.runtimeStore.get(runId);
  }

  list(): StudioRunSnapshot[] {
    this.syncFromDisk();
    return this.runtimeStore.list();
  }

  recoverOpenRuns(options: StudioRunQueueStoreRecoveryOptions = {}): StudioRunSnapshot[] {
    this.syncFromDisk();
    const recovered = this.runtimeStore.recoverOpenRuns(options);
    this.syncToDisk();
    return recovered;
  }

  private syncFromDisk(): void {
    this.runtimeStore.clear();
    const state = this.loadState();
    if (!state) {
      return;
    }
    const tasksByRunId = new Map<string, StudioTaskQueueItem[]>();
    for (const task of state.tasks) {
      const tasks = tasksByRunId.get(task.runId) ?? [];
      tasks.push(task);
      tasksByRunId.set(task.runId, tasks);
    }
    for (const run of state.runs) {
      this.runtimeStore.save(snapshotFromRun(run, tasksByRunId.get(run.runId) ?? []));
    }
  }

  private syncToDisk(): void {
    const snapshots = this.runtimeStore.list();
    this.saveState({
      runs: snapshots.map(runFromSnapshot),
      tasks: snapshots.flatMap((snapshot) => snapshot.tasks.map((task) => ({ ...task }))),
    });
  }

  private loadState(): StudioRunQueueStoreState | null {
    if (!existsSync(this.filePath)) {
      return null;
    }
    const raw = readFileSync(this.filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`studio run queue store file is invalid: ${this.filePath}`);
    }
    const runs = (parsed as { runs?: unknown }).runs;
    const tasks = (parsed as { tasks?: unknown }).tasks;
    if (!Array.isArray(runs) || !Array.isArray(tasks)) {
      throw new Error(`studio run queue store file is invalid: ${this.filePath}`);
    }
    return {
      runs: runs.map((run) => this.readRun(run)),
      tasks: tasks.map((task) => this.readTask(task)),
    };
  }

  private readRun(raw: unknown): StoredStudioRun {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`studio run queue store run is invalid: ${this.filePath}`);
    }
    const run = raw as Partial<Record<keyof StoredStudioRun, unknown>>;
    if (typeof run.runId !== 'string' || run.runId.length === 0) {
      throw new Error(`studio run queue store run is missing runId: ${this.filePath}`);
    }
    if (typeof run.conversationId !== 'string' || run.conversationId.length === 0) {
      throw new Error(`studio run queue store run is missing conversationId: ${this.filePath}`);
    }
    if (typeof run.userRequest !== 'string') {
      throw new Error(`studio run queue store run is missing userRequest: ${this.filePath}`);
    }
    if (!this.isRunStatus(run.status)) {
      throw new Error(`studio run queue store run has invalid status: ${this.filePath}`);
    }
    if (typeof run.createdAt !== 'string' || typeof run.updatedAt !== 'string') {
      throw new Error(`studio run queue store run is missing timestamps: ${this.filePath}`);
    }
    return {
      runId: run.runId,
      conversationId: run.conversationId,
      userRequest: run.userRequest,
      status: run.status,
      finalTaskIndex: typeof run.finalTaskIndex === 'number' ? run.finalTaskIndex : undefined,
      finalInvocationId: typeof run.finalInvocationId === 'string'
        ? run.finalInvocationId
        : undefined,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  }

  private readTask(raw: unknown): StudioTaskQueueItem {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`studio run queue store task is invalid: ${this.filePath}`);
    }
    const task = raw as Partial<Record<keyof StudioTaskQueueItem, unknown>>;
    if (typeof task.runId !== 'string' || task.runId.length === 0) {
      throw new Error(`studio run queue store task is missing runId: ${this.filePath}`);
    }
    if (typeof task.conversationId !== 'string' || task.conversationId.length === 0) {
      throw new Error(`studio run queue store task is missing conversationId: ${this.filePath}`);
    }
    if (typeof task.taskIndex !== 'number') {
      throw new Error(`studio run queue store task is missing taskIndex: ${this.filePath}`);
    }
    if (typeof task.petId !== 'string' || typeof task.brief !== 'string') {
      throw new Error(`studio run queue store task is missing worker fields: ${this.filePath}`);
    }
    if (!this.isTaskStatus(task.status)) {
      throw new Error(`studio run queue store task has invalid status: ${this.filePath}`);
    }
    // Studio 不背兼容包袱:旧格式(无 taskId / invocations)直接拒绝,
    // 而不是补默认值 —— 那会造出没有身份、重试预算为 0 的 task。
    if (typeof task.taskId !== 'string' || task.taskId.length === 0) {
      throw new Error(`studio run queue store task is missing taskId: ${this.filePath}`);
    }
    if (!Array.isArray(task.invocations)) {
      throw new Error(`studio run queue store task is missing invocations: ${this.filePath}`);
    }
    return {
      runId: task.runId,
      conversationId: task.conversationId,
      taskId: task.taskId,
      taskIndex: task.taskIndex,
      petId: task.petId,
      brief: task.brief,
      acceptanceCriteria: Array.isArray(task.acceptanceCriteria)
        ? task.acceptanceCriteria.filter((item): item is string => typeof item === 'string')
        : [],
      deps: Array.isArray(task.deps)
        ? task.deps.filter((item): item is number => typeof item === 'number')
        : [],
      status: task.status,
      invocations: task.invocations.map((raw) => this.readInvocation(raw)),
      errorMessage: typeof task.errorMessage === 'string' ? task.errorMessage : undefined,
      enqueuedAt: typeof task.enqueuedAt === 'string' ? task.enqueuedAt : '',
      startedAt: typeof task.startedAt === 'string' ? task.startedAt : undefined,
      finishedAt: typeof task.finishedAt === 'string' ? task.finishedAt : undefined,
    };
  }

  private readInvocation(raw: unknown): StudioInvocation {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`studio run queue store invocation is invalid: ${this.filePath}`);
    }
    const invocation = raw as Partial<Record<keyof StudioInvocation, unknown>>;
    if (typeof invocation.invocationId !== 'string' || invocation.invocationId.length === 0) {
      throw new Error(`studio run queue store invocation is missing invocationId: ${this.filePath}`);
    }
    if (typeof invocation.petId !== 'string' || typeof invocation.attempt !== 'number') {
      throw new Error(`studio run queue store invocation is missing pet/attempt: ${this.filePath}`);
    }
    if (!this.isInvocationStatus(invocation.status)) {
      throw new Error(`studio run queue store invocation has invalid status: ${this.filePath}`);
    }
    return {
      invocationId: invocation.invocationId,
      petId: invocation.petId,
      attempt: invocation.attempt,
      status: invocation.status,
      startedAt: typeof invocation.startedAt === 'string' ? invocation.startedAt : '',
      ...(typeof invocation.finishedAt === 'string'
        ? { finishedAt: invocation.finishedAt }
        : {}),
      ...(typeof invocation.errorMessage === 'string'
        ? { errorMessage: invocation.errorMessage }
        : {}),
    };
  }

  private isInvocationStatus(value: unknown): value is StudioInvocation['status'] {
    return value === 'running'
      || value === 'succeeded'
      || value === 'failed'
      || value === 'cancelled';
  }

  private saveState(state: StudioRunQueueStoreState): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, this.filePath);
  }

  private isRunStatus(value: unknown): value is StudioRunStatus {
    return value === 'planning'
      || value === 'running'
      || value === 'blocked'
      || value === 'done'
      || value === 'failed'
      || value === 'cancelled';
  }

  private isTaskStatus(value: unknown): value is StudioTaskQueueItem['status'] {
    return value === 'queued'
      || value === 'running'
      || value === 'done'
      || value === 'failed'
      || value === 'cancelled';
  }
}
