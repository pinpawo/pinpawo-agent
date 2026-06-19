import {
  applyStudioDueRunEvent,
  buildStudioDueRunRecord,
  canRetry,
  type StudioDueRunEvent,
  type StudioDueRunRecord,
  type StudioDueRunStatus,
} from './dueRunContract';
import { buildStudioRunIdentity } from './types';

export type StudioDueRunStoreInput = {
  runId: string;
  conversationId?: string;
  workdir: string;
  ownerUserId?: string | null;
  userRequest: string;
  now?: string;
};

export type StudioDueRunStoreTrace = {
  runId: string;
  conversationId: string;
  idempotencyKey: string;
  workdir: string;
  status: StudioDueRunStatus;
  attempt: number;
  claimedAt?: string;
  completedAt?: string;
  ownerUserId: string | null;
  errorCode?: string;
  errorDetail?: string;
  finalDispatchId?: string;
};

export type StudioDueRunClaim = {
  run: StudioDueRunRecord;
  token: string;
};

export type StudioDueRunClaimFilter = {
  workdir?: string | string[];
};

export type StudioDueRunStoreOptions = {
  now?: () => string;
  retryDelayMs?: number;
};

export type StudioDueRunStore = {
  clear(): void;
  submit(input: StudioDueRunStoreInput): StudioDueRunRecord;
  restore(rows: StudioDueRunRecord[]): void;
  getByRunId(runId: string): StudioDueRunRecord | null;
  getByIdempotencyKey(idempotencyKey: string): StudioDueRunRecord | null;
  list(): StudioDueRunRecord[];
  listTrace(): StudioDueRunStoreTrace[];
  claim(
    ownerUserId: string | null,
    filter?: StudioDueRunClaimFilter,
  ): StudioDueRunClaim | null;
  start(claim: StudioDueRunClaim): StudioDueRunRecord;
  succeed(
    claim: StudioDueRunClaim,
    payload: { finalDispatchId?: string; reply?: string },
  ): StudioDueRunRecord;
  fail(
    claim: StudioDueRunClaim,
    payload: {
      errorCode?: string;
      errorDetail?: string;
      retryAfterMs?: number;
    },
  ): StudioDueRunRecord;
  cancel(claim: StudioDueRunClaim): StudioDueRunRecord;
  retry(claim: StudioDueRunClaim): StudioDueRunRecord;
};

const BASE_CLAIM_TOKEN = 'studio-due-run-claim';

export class InMemoryStudioDueRunStore implements StudioDueRunStore {
  private readonly rows = new Map<string, StudioDueRunRecord>();
  private readonly now: () => string;
  private readonly retryDelayMs: number;

  constructor(options: StudioDueRunStoreOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.retryDelayMs = options.retryDelayMs ?? 0;
  }

  submit(input: StudioDueRunStoreInput): StudioDueRunRecord {
    const identity = buildStudioRunIdentity({
      runId: input.runId,
      conversationId: input.conversationId,
    });
    const existed = this.rows.get(identity.idempotencyKey);
    if (existed) {
      return existed;
    }

    const row = buildStudioDueRunRecord({
      runId: identity.runId,
      conversationId: identity.conversationId,
      workdir: input.workdir,
      ownerUserId: input.ownerUserId,
      userRequest: input.userRequest,
      now: input.now,
    });

    this.rows.set(identity.idempotencyKey, row);
    return row;
  }

  clear(): void {
    this.rows.clear();
  }

  restore(rows: StudioDueRunRecord[]): void {
    this.clear();
    for (const row of rows) {
      const identity = row.identity ?? buildStudioRunIdentity({
        runId: row.runId,
        conversationId: row.conversationId,
      });
      const restored: StudioDueRunRecord = {
        ...row,
        identity,
      };
      this.rows.set(identity.idempotencyKey, restored);
    }
  }

  getByRunId(runId: string): StudioDueRunRecord | null {
    for (const row of this.rows.values()) {
      if (row.runId === runId) {
        return row;
      }
    }
    return null;
  }

  getByIdempotencyKey(idempotencyKey: string): StudioDueRunRecord | null {
    return this.rows.get(idempotencyKey) ?? null;
  }

  list(): StudioDueRunRecord[] {
    return Array.from(this.rows.values())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  listTrace(): StudioDueRunStoreTrace[] {
    return this.list().map((row) => ({
      runId: row.runId,
      conversationId: row.conversationId,
      idempotencyKey: row.identity.idempotencyKey,
      workdir: row.workdir,
      status: row.status,
      attempt: row.attempt,
      claimedAt: row.claimedAt,
      completedAt: row.completedAt,
      ownerUserId: row.ownerUserId,
      errorCode: row.errorCode,
      errorDetail: row.errorDetail,
      finalDispatchId: row.finalDispatchId,
    }));
  }

  claim(ownerUserId: string | null, filter: StudioDueRunClaimFilter = {}): StudioDueRunClaim | null {
    const now = this.now();
    const candidate = this.list()
      .find((row) => this.canBeClaimed(row, now, filter));
    if (!candidate) {
      return null;
    }

    const updated = this.apply(
      candidate,
      { type: 'claim' },
      { now, ownerUserId },
    );

    return {
      run: updated,
      token: this.buildClaimToken(updated),
    };
  }

  start(claim: StudioDueRunClaim): StudioDueRunRecord {
    return this.applyWithClaim(claim, { type: 'start' }, 'starting');
  }

  succeed(
    claim: StudioDueRunClaim,
    payload: { finalDispatchId?: string; reply?: string },
  ): StudioDueRunRecord {
    return this.applyWithClaim(
      claim,
      {
        type: 'succeed',
        finalDispatchId: payload.finalDispatchId,
        reply: payload.reply,
      },
      'succeeding',
    );
  }

  fail(
    claim: StudioDueRunClaim,
    payload: {
      errorCode?: string;
      errorDetail?: string;
      retryAfterMs?: number;
    },
  ): StudioDueRunRecord {
    const row = this.getByIdempotencyKey(claim.run.identity.idempotencyKey);
    if (!row) {
      throw new Error(`studio due run not found for failing: ${claim.run.runId}`);
    }
    if (this.buildClaimToken(row) !== claim.token) {
      throw new Error(`studio due run claim token mismatch for failing: ${claim.run.runId}`);
    }

    const now = this.now();
    const retryAfterMs = payload.retryAfterMs ?? this.retryDelayMs;
    const nowAt = Date.parse(now);
    const runAt = retryAfterMs <= 0 || Number.isNaN(nowAt)
      ? undefined
      : new Date(nowAt + retryAfterMs).toISOString();

    return this.apply(
      row,
      {
        type: 'fail',
        errorCode: payload.errorCode,
        errorDetail: payload.errorDetail,
        runAt,
      },
      { now, ownerUserId: row.ownerUserId },
    );
  }

  cancel(claim: StudioDueRunClaim): StudioDueRunRecord {
    return this.applyWithClaim(claim, { type: 'cancel' }, 'canceling');
  }

  retry(claim: StudioDueRunClaim): StudioDueRunRecord {
    const row = this.getByIdempotencyKey(claim.run.identity.idempotencyKey);
    if (!row) {
      throw new Error(`studio due run not found for retrying: ${claim.run.runId}`);
    }

    const now = this.now();
    if (!this.canRetryAt(row, now)) {
      throw new Error(`studio due run not ready for retry: ${claim.run.runId}`);
    }

    return this.applyWithClaim(claim, { type: 'retry' }, 'retrying');
  }

  private canBeClaimed(
    row: StudioDueRunRecord,
    now: string,
    filter: StudioDueRunClaimFilter,
  ): boolean {
    if (row.status !== 'pending') {
      return false;
    }

    const runAt = row.runAt ? Date.parse(row.runAt) : NaN;
    const nowAt = Date.parse(now);
    if (!Number.isNaN(runAt) && !Number.isNaN(nowAt) && nowAt < runAt) {
      return false;
    }

    if (filter.workdir) {
      const allowedWorkdirs = Array.isArray(filter.workdir)
        ? filter.workdir
        : [filter.workdir];
      if (!allowedWorkdirs.includes(row.workdir)) {
        return false;
      }
    }

    return true;
  }

  private canRetryAt(row: StudioDueRunRecord, now: string): boolean {
    if (!canRetry(row)) {
      return false;
    }

    const runAt = row.runAt ? Date.parse(row.runAt) : NaN;
    const nowAt = Date.parse(now);

    if (Number.isNaN(runAt) || Number.isNaN(nowAt)) {
      return true;
    }

    return nowAt >= runAt;
  }

  private buildClaimToken(row: StudioDueRunRecord) {
    return `${BASE_CLAIM_TOKEN}:${row.identity.idempotencyKey}:${row.attempt}`;
  }

  private applyWithClaim(
    claim: StudioDueRunClaim,
    event: StudioDueRunEvent,
    actionNameForError: string,
  ): StudioDueRunRecord {
    const row = this.getByIdempotencyKey(claim.run.identity.idempotencyKey);
    if (!row) {
      throw new Error(`studio due run not found for ${actionNameForError}: ${claim.run.runId}`);
    }
    if (this.buildClaimToken(row) !== claim.token) {
      throw new Error(`studio due run claim token mismatch for ${actionNameForError}: ${claim.run.runId}`);
    }
    return this.apply(row, event, { ownerUserId: row.ownerUserId });
  }

  private apply(
    row: StudioDueRunRecord,
    event: StudioDueRunEvent,
    options: {
      now?: string;
      ownerUserId?: string | null;
    } = {},
  ): StudioDueRunRecord {
    const now = options.now ?? this.now();
    const next = applyStudioDueRunEvent(row, event, now);
    if (options.ownerUserId !== undefined) {
      next.ownerUserId = options.ownerUserId;
    }
    this.rows.set(next.identity.idempotencyKey, next);
    return next;
  }
}
