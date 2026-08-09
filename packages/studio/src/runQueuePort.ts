import type {
  StudioRun,
  StudioRunSnapshot,
  StudioRunStatus,
  StudioTaskQueueItem,
} from './types';

/**
 * Run queue port —— Studio 声明它需要一个能持久化 run/task 快照的东西,
 * 不关心背后是文件、S3 还是数据库。
 *
 * 实现住在 toolkit 层,由宿主注入。
 */

export type StudioRunQueueStoreRecoveryOptions = {
  now?: string;
};

export type StudioRunQueueStore = {
  clear(): void;
  save(snapshot: StudioRunSnapshot): StudioRunSnapshot;
  get(runId: string): StudioRunSnapshot | null;
  list(): StudioRunSnapshot[];
  /**
   * 崩溃恢复:返回仍处于开放状态的 run。实现需要把恢复出来的 running task
   * 归一化为 failed —— 进程已经不在了,它们不可能还在跑。
   */
  recoverOpenRuns(options?: StudioRunQueueStoreRecoveryOptions): StudioRunSnapshot[];
};

/* ─────────────── 进程内实现 ─────────────── */

type StoredStudioRun = StudioRun;

export type StudioRunQueueStoreState = {
  runs: StoredStudioRun[];
  tasks: StudioTaskQueueItem[];
};

export const OPEN_RUN_STATUSES = new Set<StudioRunStatus>(['planning', 'running', 'blocked']);

export function cloneSnapshot(snapshot: StudioRunSnapshot): StudioRunSnapshot {
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

export function runFromSnapshot(snapshot: StudioRunSnapshot): StoredStudioRun {
  const { tasks: _tasks, ...run } = snapshot;
  return run;
}

export function snapshotFromRun(run: StoredStudioRun, tasks: StudioTaskQueueItem[]): StudioRunSnapshot {
  return cloneSnapshot({
    ...run,
    tasks: tasks.filter((task) => task.runId === run.runId),
  });
}

export function sortSnapshots(snapshots: StudioRunSnapshot[]): StudioRunSnapshot[] {
  return snapshots.sort((a, b) => {
    const byCreatedAt = a.createdAt.localeCompare(b.createdAt);
    if (byCreatedAt !== 0) return byCreatedAt;
    return a.runId.localeCompare(b.runId);
  });
}

export function recoverSnapshot(snapshot: StudioRunSnapshot, now: string): StudioRunSnapshot {
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

/**
 * 不落盘的实现:只在内存里保存,进程结束即丢弃。
 *
 * 让 orchestrator 在没有注入持久化 store 时仍可运行(测试、一次性编排),
 * 同时给 toolkit 层的持久化实现复用上面的快照归一化逻辑。
 */
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
