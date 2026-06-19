import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type {
  StudioRun,
  StudioRunSnapshot,
  StudioRunStatus,
  StudioTaskQueueItem,
} from './types';

export type StudioRunQueueStoreRecoveryOptions = {
  now?: string;
};

export type StudioRunQueueStore = {
  clear(): void;
  save(snapshot: StudioRunSnapshot): StudioRunSnapshot;
  get(runId: string): StudioRunSnapshot | null;
  list(): StudioRunSnapshot[];
  recoverOpenRuns(options?: StudioRunQueueStoreRecoveryOptions): StudioRunSnapshot[];
};

type StoredStudioRun = StudioRun;

type StudioRunQueueStoreState = {
  runs: StoredStudioRun[];
  tasks: StudioTaskQueueItem[];
};

const OPEN_RUN_STATUSES = new Set<StudioRunStatus>(['planning', 'running', 'blocked']);

function cloneSnapshot(snapshot: StudioRunSnapshot): StudioRunSnapshot {
  return {
    runId: snapshot.runId,
    conversationId: snapshot.conversationId,
    userRequest: snapshot.userRequest,
    status: snapshot.status,
    finalTaskIndex: snapshot.finalTaskIndex,
    finalPetRunId: snapshot.finalPetRunId,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    tasks: snapshot.tasks
      .map((task) => ({ ...task }))
      .sort((a, b) => a.taskIndex - b.taskIndex),
  };
}

function runFromSnapshot(snapshot: StudioRunSnapshot): StoredStudioRun {
  const { tasks: _tasks, ...run } = snapshot;
  return run;
}

function snapshotFromRun(run: StoredStudioRun, tasks: StudioTaskQueueItem[]): StudioRunSnapshot {
  return cloneSnapshot({
    ...run,
    tasks: tasks.filter((task) => task.runId === run.runId),
  });
}

function sortSnapshots(snapshots: StudioRunSnapshot[]): StudioRunSnapshot[] {
  return snapshots.sort((a, b) => {
    const byCreatedAt = a.createdAt.localeCompare(b.createdAt);
    if (byCreatedAt !== 0) return byCreatedAt;
    return a.runId.localeCompare(b.runId);
  });
}

function recoverSnapshot(snapshot: StudioRunSnapshot, now: string): StudioRunSnapshot {
  if (!OPEN_RUN_STATUSES.has(snapshot.status)) {
    return cloneSnapshot(snapshot);
  }

  let hasRecoveredRunningTask = false;
  const tasks = snapshot.tasks.map((task) => {
    if (task.status !== 'running') {
      return { ...task };
    }
    hasRecoveredRunningTask = true;
    return {
      ...task,
      status: 'failed' as const,
      finishedAt: task.finishedAt ?? now,
      errorMessage: task.errorMessage ?? 'recovered_running_task_requires_reconcile',
    };
  });

  return {
    ...snapshot,
    status: hasRecoveredRunningTask ? 'blocked' : snapshot.status,
    updatedAt: hasRecoveredRunningTask ? now : snapshot.updatedAt,
    tasks,
  };
}

export class InMemoryStudioRunQueueStore implements StudioRunQueueStore {
  private readonly runs = new Map<string, StoredStudioRun>();
  private readonly tasksByRunId = new Map<string, StudioTaskQueueItem[]>();

  clear(): void {
    this.runs.clear();
    this.tasksByRunId.clear();
  }

  save(snapshot: StudioRunSnapshot): StudioRunSnapshot {
    const next = cloneSnapshot(snapshot);
    this.runs.set(next.runId, runFromSnapshot(next));
    this.tasksByRunId.set(next.runId, next.tasks.map((task) => ({ ...task })));
    return this.get(next.runId) ?? next;
  }

  get(runId: string): StudioRunSnapshot | null {
    const run = this.runs.get(runId);
    if (!run) {
      return null;
    }
    return snapshotFromRun(run, this.tasksByRunId.get(runId) ?? []);
  }

  list(): StudioRunSnapshot[] {
    return sortSnapshots(Array.from(this.runs.keys())
      .map((runId) => this.get(runId))
      .filter((snapshot): snapshot is StudioRunSnapshot => Boolean(snapshot)));
  }

  recoverOpenRuns(options: StudioRunQueueStoreRecoveryOptions = {}): StudioRunSnapshot[] {
    const now = options.now ?? new Date().toISOString();
    const recovered: StudioRunSnapshot[] = [];
    for (const snapshot of this.list()) {
      if (!OPEN_RUN_STATUSES.has(snapshot.status)) {
        continue;
      }
      const next = recoverSnapshot(snapshot, now);
      this.save(next);
      recovered.push(next);
    }
    return recovered;
  }
}

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
      finalPetRunId: typeof run.finalPetRunId === 'string' ? run.finalPetRunId : undefined,
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
    return {
      runId: task.runId,
      conversationId: task.conversationId,
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
      petRunId: typeof task.petRunId === 'string' ? task.petRunId : undefined,
      errorMessage: typeof task.errorMessage === 'string' ? task.errorMessage : undefined,
      enqueuedAt: typeof task.enqueuedAt === 'string' ? task.enqueuedAt : '',
      startedAt: typeof task.startedAt === 'string' ? task.startedAt : undefined,
      finishedAt: typeof task.finishedAt === 'string' ? task.finishedAt : undefined,
    };
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
