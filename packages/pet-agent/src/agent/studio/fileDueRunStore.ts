import { existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  InMemoryStudioDueRunStore,
  type StudioDueRunClaim,
  type StudioDueRunClaimFilter,
  type StudioDueRunStore,
  type StudioDueRunStoreInput,
  type StudioDueRunStoreOptions,
  type StudioDueRunStoreTrace,
} from './dueRunScheduler';
import type { StudioDueRunRecord, StudioDueRunStatus } from './dueRunContract';
import { buildStudioRunIdentity } from './types';

type DueRunStoreRow = Omit<StudioDueRunRecord, 'identity'> & {
  identity?: {
    runId: string;
    conversationId: string;
    idempotencyKey: string;
  };
};

type DueRunStoreState = {
  rows: DueRunStoreRow[];
};

type StudioDueRunStorePersistOptions = StudioDueRunStoreOptions & {
  filePath: string;
  lockPath?: string;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
};

const DEFAULT_LOCK_TIMEOUT_MS = 1500;
const DEFAULT_LOCK_RETRY_MS = 10;
const VALID_STATUSES = new Set<StudioDueRunStatus>(['pending', 'claimed', 'running', 'success', 'failed', 'canceled']);

export class FileStudioDueRunStore implements StudioDueRunStore {
  private readonly runtimeStore: InMemoryStudioDueRunStore;
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;

  constructor(options: StudioDueRunStorePersistOptions) {
    this.runtimeStore = new InMemoryStudioDueRunStore({
      now: options.now,
      retryDelayMs: options.retryDelayMs,
    });
    this.filePath = options.filePath;
    this.lockPath = options.lockPath ?? `${options.filePath}.lock`;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.lockRetryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;

    this.syncFromDisk();
  }

  clear(): void {
    return this.withLock(() => {
      this.runtimeStore.clear();
      this.syncToDisk();
    });
  }

  restore(rows: StudioDueRunRecord[]): void {
    return this.withLock(() => {
      this.runtimeStore.restore(rows);
      this.syncToDisk();
    });
  }

  submit(input: StudioDueRunStoreInput): StudioDueRunRecord {
    return this.withLock(() => {
      this.syncFromDisk();
      const row = this.runtimeStore.submit(input);
      this.syncToDisk();
      return row;
    });
  }

  getByRunId(runId: string): StudioDueRunRecord | null {
    return this.withLock(() => {
      this.syncFromDisk();
      return this.runtimeStore.getByRunId(runId);
    });
  }

  getByIdempotencyKey(idempotencyKey: string): StudioDueRunRecord | null {
    return this.withLock(() => {
      this.syncFromDisk();
      return this.runtimeStore.getByIdempotencyKey(idempotencyKey);
    });
  }

  list(): StudioDueRunRecord[] {
    return this.withLock(() => {
      this.syncFromDisk();
      return this.runtimeStore.list();
    });
  }

  listTrace(): StudioDueRunStoreTrace[] {
    return this.withLock(() => {
      this.syncFromDisk();
      return this.runtimeStore.listTrace();
    });
  }

  claim(ownerUserId: string | null, filter: StudioDueRunClaimFilter = {}): StudioDueRunClaim | null {
    return this.withLock(() => {
      this.syncFromDisk();
      const claim = this.runtimeStore.claim(ownerUserId, filter);
      if (claim) {
        this.syncToDisk();
      }
      return claim;
    });
  }

  start(claim: StudioDueRunClaim): StudioDueRunRecord {
    return this.withLock(() => {
      this.syncFromDisk();
      const row = this.runtimeStore.start(claim);
      this.syncToDisk();
      return row;
    });
  }

  succeed(
    claim: StudioDueRunClaim,
    payload: { finalDispatchId?: string; reply?: string },
  ): StudioDueRunRecord {
    return this.withLock(() => {
      this.syncFromDisk();
      const row = this.runtimeStore.succeed(claim, payload);
      this.syncToDisk();
      return row;
    });
  }

  fail(
    claim: StudioDueRunClaim,
    payload: { errorCode?: string; errorDetail?: string; retryAfterMs?: number },
  ): StudioDueRunRecord {
    return this.withLock(() => {
      this.syncFromDisk();
      const row = this.runtimeStore.fail(claim, payload);
      this.syncToDisk();
      return row;
    });
  }

  cancel(claim: StudioDueRunClaim): StudioDueRunRecord {
    return this.withLock(() => {
      this.syncFromDisk();
      const row = this.runtimeStore.cancel(claim);
      this.syncToDisk();
      return row;
    });
  }

  retry(claim: StudioDueRunClaim): StudioDueRunRecord {
    return this.withLock(() => {
      this.syncFromDisk();
      const row = this.runtimeStore.retry(claim);
      this.syncToDisk();
      return row;
    });
  }

  private withLock<T>(action: () => T): T {
    const deadline = Date.now() + this.lockTimeoutMs;
    let fd = -1;

    while (true) {
      try {
        fd = openSync(this.lockPath, 'wx');
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        if (Date.now() >= deadline) {
          throw new Error(`studio due run store lock timeout: ${this.lockPath}`);
        }
        this.sleep(this.lockRetryMs);
      }
    }

    try {
      return action();
    } finally {
      if (fd >= 0) {
        closeSync(fd);
      }
      try {
        unlinkSync(this.lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }

  private syncFromDisk(): void {
    this.runtimeStore.clear();
    const state = this.loadState();
    if (!state) {
      return;
    }

    const rows: StudioDueRunRecord[] = [];
    for (const row of state.rows) {
      const identity = row.identity
        ?? buildStudioRunIdentity({ runId: row.runId, conversationId: row.conversationId });
      rows.push({
        ...row,
        identity,
      });
    }
    this.runtimeStore.restore(rows);
  }

  private syncToDisk(): void {
    const rows = this.runtimeStore.list();
    const state: DueRunStoreState = {
      rows: rows.map((row) => {
        // Strip derived field to keep serialized payload stable and compact.
        const { identity, ...rest } = row;
        return {
          ...rest,
          status: rest.status,
        };
      }),
    };
    this.saveState(state);
  }

  private loadState(): DueRunStoreState | null {
    if (!existsSync(this.filePath)) {
      return null;
    }

    const raw = readFileSync(this.filePath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(`studio due run persistence file is not valid JSON: ${(error as Error).message}`);
    }

    if (typeof parsed !== 'object' || parsed === null || !('rows' in parsed)) {
      throw new Error(`studio due run persistence file is invalid: ${this.filePath}`);
    }
    const maybeRows = (parsed as { rows: unknown }).rows;
    if (!Array.isArray(maybeRows)) {
      throw new Error(`studio due run persistence file is invalid: ${this.filePath}`);
    }

    return {
      rows: maybeRows.map((row) => this.readRow(row)),
    };
  }

  private readRow(rawRow: unknown): DueRunStoreRow {
    if (!rawRow || typeof rawRow !== 'object') {
      throw new Error(`studio due run persistence row is invalid: ${this.filePath}`);
    }

    const row = rawRow as Partial<Record<keyof DueRunStoreRow, unknown>>;
    if (typeof row.runId !== 'string' || row.runId.trim().length === 0) {
      throw new Error(`studio due run persistence row is missing runId: ${this.filePath}`);
    }
    if (typeof row.conversationId !== 'string' || row.conversationId.trim().length === 0) {
      throw new Error(`studio due run persistence row is missing conversationId: ${this.filePath}`);
    }
    if (typeof row.workdir !== 'string' || row.workdir.trim().length === 0) {
      throw new Error(`studio due run persistence row is missing workdir: ${this.filePath}`);
    }
    if (typeof row.ownerUserId !== 'string' && row.ownerUserId !== null) {
      throw new Error(`studio due run persistence row has invalid ownerUserId: ${this.filePath}`);
    }
    if (typeof row.userRequest !== 'string') {
      throw new Error(`studio due run persistence row has invalid userRequest: ${this.filePath}`);
    }
    if (!VALID_STATUSES.has(row.status as StudioDueRunStatus)) {
      throw new Error(`studio due run persistence row has invalid status: ${this.filePath}`);
    }
    if (typeof row.attempt !== 'number' || !Number.isInteger(row.attempt) || row.attempt < 0) {
      throw new Error(`studio due run persistence row has invalid attempt: ${this.filePath}`);
    }
    if (typeof row.createdAt !== 'string' || row.createdAt.trim().length === 0) {
      throw new Error(`studio due run persistence row has invalid createdAt: ${this.filePath}`);
    }
    if (typeof row.updatedAt !== 'string' || row.updatedAt.trim().length === 0) {
      throw new Error(`studio due run persistence row has invalid updatedAt: ${this.filePath}`);
    }

    if (row.identity !== undefined && typeof row.identity !== 'object') {
      throw new Error(`studio due run persistence row has invalid identity: ${this.filePath}`);
    }

    return {
      runId: row.runId,
      conversationId: row.conversationId,
      workdir: row.workdir,
      userRequest: row.userRequest,
      ownerUserId: row.ownerUserId ?? null,
      status: row.status as StudioDueRunStatus,
      attempt: row.attempt,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
      identity: {
        runId: row.runId,
        conversationId: row.conversationId,
        idempotencyKey: `studio:${row.conversationId}:run:${row.runId}`,
      },
      ...(typeof row.runAt === 'string' ? { runAt: row.runAt } : {}),
      ...(typeof row.errorCode === 'string' ? { errorCode: row.errorCode } : {}),
      ...(typeof row.errorDetail === 'string' ? { errorDetail: row.errorDetail } : {}),
      ...(typeof row.finalDispatchId === 'string' ? { finalDispatchId: row.finalDispatchId } : {}),
      ...(typeof row.reply === 'string' ? { reply: row.reply } : {}),
      ...(typeof row.claimedAt === 'string' ? { claimedAt: row.claimedAt } : {}),
      ...(typeof row.completedAt === 'string' ? { completedAt: row.completedAt } : {}),
    };
  }

  private saveState(state: DueRunStoreState): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp-${Date.now()}`;
    writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf-8');
    try {
      renameSync(tempPath, this.filePath);
    } catch (error) {
      try {
        unlinkSync(tempPath);
      } catch {
      }
      throw error;
    }
  }

  private sleep(ms: number): void {
    const sleeper = new SharedArrayBuffer(4);
    const lock = new Int32Array(sleeper);
    Atomics.wait(lock, 0, 0, ms);
  }
}
