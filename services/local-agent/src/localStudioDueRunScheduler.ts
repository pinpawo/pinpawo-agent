import { setTimeout as sleep } from 'node:timers/promises';
import {
  StudioTurnEvent,
  StudioTurnResult,
} from '@pinpawo/studio';
import {
  isTerminalStudioDueRunStatus,
  type StudioDueRunRecord,
  type StudioDueRunStore,
  type StudioDueRunStoreTrace,
  type StudioDueRunClaim,
} from '@pinpawo/studio';
import type { PendingReviewSlot } from './studio/studioBridge';
import { getLocalServerWorkdir, type LocalServerDeps } from './localServerTypes';
import { StudioRunService } from './studioRunService';

export type LocalStudioDueRunCompletion = {
  runId: string;
  conversationId: string;
  idempotencyKey: string;
  workdir: string;
  outcome: 'done' | 'stopped';
  reply: string;
  finalPetRunId?: string;
  reason?: string;
};

export type LocalStudioDueRunSubmitOptions = {
  deps: LocalServerDeps;
  requestId: string;
  runId: string;
  userRequest: string;
  conversationId?: string;
  send: (envelope: unknown) => void;
  onProgress: (event: StudioTurnEvent) => void;
  slot: PendingReviewSlot;
  ownerUserId?: string | null;
  signal?: AbortSignal;
};

export type LocalStudioDueRunTimingStats = {
  count: number;
  averageMs?: number;
  minMs?: number;
  maxMs?: number;
};

export type LocalStudioDueRunMetrics = {
  statusCounts: Record<string, number>;
  totalRows: number;
  totalAttempts: number;
  retriedRows: number;
  retriedAttempts: number;
  queueWaitMs: LocalStudioDueRunTimingStats;
  runDurationMs: LocalStudioDueRunTimingStats;
  failureCodeCounts: Record<string, number>;
};

type Waiter = LocalStudioDueRunSubmitOptions & {
  idempotencyKey: string;
  resolve: (result: LocalStudioDueRunCompletion) => void;
  reject: (error: unknown) => void;
  settled: boolean;
  abortHandler?: () => void;
};

type LocalStudioDueRunSchedulerOptions = {
  store: StudioDueRunStore;
  studioRunService?: StudioRunService;
  filterWorkdir?: string | string[];
  ownerUserId?: string | null;
  pollIntervalMs?: number;
  defaultFinalPetRunId?: string;
};

export class LocalStudioDueRunScheduler {
  private readonly studioRunService: StudioRunService;
  private readonly studioDueRuns: StudioDueRunStore;
  private readonly filterWorkdir?: string | string[];
  private readonly ownerUserId: string | null;
  private readonly pollIntervalMs: number;
  private readonly defaultFinalPetRunId: string | undefined;
  private readonly waitersByKey = new Map<string, Set<Waiter>>();
  private readonly claimRunning = new Set<string>();
  private stopSignal = new AbortController();
  private loopStarted = false;

  private readonly filterWorkdirList: string[] | null;

  constructor(options: LocalStudioDueRunSchedulerOptions) {
    this.studioRunService = options.studioRunService ?? new StudioRunService();
    this.studioDueRuns = options.store;
    this.filterWorkdir = options.filterWorkdir;
    this.filterWorkdirList = this.normalizeWorkdirFilter(this.filterWorkdir);
    this.ownerUserId = options.ownerUserId ?? null;
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
    this.defaultFinalPetRunId = options.defaultFinalPetRunId;
  }

  async submit(input: LocalStudioDueRunSubmitOptions): Promise<LocalStudioDueRunCompletion> {
    if (this.stopSignal.signal.aborted) {
      throw new DOMException('scheduler stopped', 'AbortError');
    }

    const workdir = getLocalServerWorkdir(input.deps);
    if (!this.matchesWorkdirFilter(workdir)) {
      throw new DOMException(
        `studio request workdir ${workdir} is outside scheduler scope`,
        'NotAllowedError',
      );
    }

    const row = this.studioDueRuns.submit({
      runId: input.runId,
      conversationId: input.conversationId,
      workdir,
      ownerUserId: input.ownerUserId ?? null,
      userRequest: input.userRequest,
    });

    if (isTerminalStudioDueRunStatus(row.status)) {
      return this.toCompletionFromTerminalRow(row);
    }

    const result = await new Promise<LocalStudioDueRunCompletion>((resolve, reject) => {
      const waiter: Waiter = {
        ...input,
        idempotencyKey: row.identity.idempotencyKey,
        resolve,
        reject,
        settled: false,
      };

      this.addWaiter(waiter);

      if (input.signal) {
        if (input.signal.aborted) {
          this.settleWaiter(waiter, 'reject', new DOMException('aborted', 'AbortError'));
          return;
        }
        const abort = () => {
          this.settleWaiter(waiter, 'reject', new DOMException('aborted', 'AbortError'));
        };
        waiter.abortHandler = abort;
        input.signal.addEventListener('abort', abort, { once: true });
      }

      this.ensureLoopRunning();
    });

    return result;
  }

  stop() {
    this.stopSignal.abort();
    for (const waiters of this.waitersByKey.values()) {
      for (const waiter of Array.from(waiters)) {
        this.settleWaiter(waiter, 'reject', new DOMException('aborted', 'AbortError'));
      }
    }
    this.waitersByKey.clear();
  }

  async trace(): Promise<StudioDueRunStoreTrace[]> {
    return this.studioDueRuns.listTrace().filter((row) => this.matchesWorkdirFilter(row.workdir));
  }

  async metrics(): Promise<LocalStudioDueRunMetrics> {
    const trace = await this.trace();
    return this.computeMetrics(trace);
  }

  private normalizeWorkdirFilter(
    filter: string | string[] | undefined,
  ): string[] | null {
    if (!filter) return null;
    const next = Array.isArray(filter) ? filter : [filter];
    const normalized = next.filter(Boolean);
    return normalized.length > 0 ? normalized : null;
  }

  private matchesWorkdirFilter(workdir: string) {
    return !this.filterWorkdirList || this.filterWorkdirList.includes(workdir);
  }

  private ensureLoopRunning() {
    if (this.loopStarted) {
      return;
    }
    this.loopStarted = true;
    this.runLoop().catch((error) => {
      console.error('[local-studio-scheduler] loop crashed:', error instanceof Error ? error.message : error);
      this.loopStarted = false;
    });
  }

  private async runLoop() {
    while (!this.stopSignal.signal.aborted) {
      const claim = this.studioDueRuns.claim(this.ownerUserId, this.filterWorkdir ? {
        workdir: this.filterWorkdir,
      } : undefined);

      if (!claim) {
        await sleep(this.pollIntervalMs, this.stopSignal.signal).catch(() => undefined);
        continue;
      }

      if (this.claimRunning.has(claim.run.identity.idempotencyKey)) {
        continue;
      }
      this.claimRunning.add(claim.run.identity.idempotencyKey);
      await this.execute(claim).finally(() => {
        this.claimRunning.delete(claim.run.identity.idempotencyKey);
      });
    }
  }

  private async execute(claim: StudioDueRunClaim) {
    const idempotencyKey = claim.run.identity.idempotencyKey;
    const waiters = this.getWaiters(idempotencyKey);
    const activeWaiters = waiters.filter((waiter) => !waiter.settled);

    if (activeWaiters.length === 0) {
      try {
        this.studioDueRuns.cancel(claim);
      } catch (error) {
        console.warn('[local-studio-scheduler] cancel due no active waiters failed:', error);
      }
      return;
    }

    const owner = activeWaiters[0];
    if (!owner) {
      return;
    }

    const executionSignal = activeWaiters.length === 1 ? owner.signal : undefined;

    let running;
    try {
      running = this.studioDueRuns.start(claim);
    } catch (error) {
      this.notifyFailure(idempotencyKey, error);
      return;
    }

    const onProgress = (event: StudioTurnEvent) => {
      this.broadcastProgress(idempotencyKey, event);
    };
    const onSend = (envelope: unknown) => {
      this.broadcastSend(idempotencyKey, envelope);
    };

    try {
      const result = await this.studioRunService.run({
        deps: owner.deps,
        runId: running.runId,
        userRequest: running.userRequest,
        conversationId: running.conversationId,
        ownerUserId: owner.ownerUserId ?? running.ownerUserId,
        signal: executionSignal,
        bridge: {
          send: onSend,
          requestId: owner.requestId,
          slot: owner.slot,
        },
        onProgress,
      });
      const completed = this.studioDueRuns.succeed(claim, {
        finalPetRunId: result.turn.outcome.outcome === 'done'
          ? result.turn.outcome.finalPetRunId
          : this.defaultFinalPetRunId,
        reply: result.turn.outcome.reply,
      });
      const completion = this.toCompletionFromResult(completed, result.turn.outcome);
      this.notifySuccess(idempotencyKey, completion);
    } catch (error) {
      const errorCode = error instanceof Error ? error.name : 'STUDIO_ERROR';
      const errorDetail = error instanceof Error ? error.message : String(error);
      try {
        const failed = this.studioDueRuns.fail(claim, { errorCode, errorDetail });
        const reason = failed.errorDetail ?? failed.errorCode ?? 'studio run failed';
        this.notifyFailure(idempotencyKey, new Error(reason));
      } catch (storeError) {
        this.notifyFailure(
          idempotencyKey,
          storeError instanceof Error ? storeError : new Error(String(storeError)),
        );
      }
    }
  }

  private addWaiter(waiter: Waiter) {
    const waiters = this.waitersByKey.get(waiter.idempotencyKey);
    if (!waiters) {
      this.waitersByKey.set(waiter.idempotencyKey, new Set([waiter]));
      return;
    }
    waiters.add(waiter);
  }

  private getWaiters(idempotencyKey: string) {
    const waiters = this.waitersByKey.get(idempotencyKey);
    if (!waiters) {
      return [];
    }
    return Array.from(waiters);
  }

  private removeWaiter(idempotencyKey: string, waiter: Waiter) {
    const waiters = this.waitersByKey.get(idempotencyKey);
    if (!waiters) {
      return;
    }
    waiters.delete(waiter);
    if (waiters.size === 0) {
      this.waitersByKey.delete(idempotencyKey);
    }
  }

  private settleWaiter(
    waiter: Waiter,
    callback: 'resolve' | 'reject',
    value: LocalStudioDueRunCompletion | unknown,
  ) {
    if (waiter.settled) {
      return;
    }
    waiter.settled = true;
    if (waiter.signal && waiter.abortHandler) {
      waiter.signal.removeEventListener('abort', waiter.abortHandler);
    }
    this.removeWaiter(waiter.idempotencyKey, waiter);

    if (callback === 'resolve') {
      waiter.resolve(value as LocalStudioDueRunCompletion);
      return;
    }
    waiter.reject(value);
  }

  private settleWaiters(idempotencyKey: string, callback: 'resolve' | 'reject', value: LocalStudioDueRunCompletion | unknown) {
    const waiters = this.getWaiters(idempotencyKey);
    for (const waiter of waiters) {
      this.settleWaiter(waiter, callback, value);
    }
  }

  private notifySuccess(idempotencyKey: string, completion: LocalStudioDueRunCompletion) {
    this.settleWaiters(idempotencyKey, 'resolve', completion);
  }

  private notifyFailure(idempotencyKey: string, error: unknown) {
    this.settleWaiters(idempotencyKey, 'reject', error);
  }

  private computeMetrics(trace: StudioDueRunStoreTrace[]): LocalStudioDueRunMetrics {
    const statusCounts: Record<string, number> = {
      pending: 0,
      claimed: 0,
      running: 0,
      success: 0,
      failed: 0,
      canceled: 0,
    };

    let queueWaitTotalMs = 0;
    let queueWaitCount = 0;
    let queueWaitMinMs: number | undefined;
    let queueWaitMaxMs: number | undefined;

    let runDurationTotalMs = 0;
    let runDurationCount = 0;
    let runDurationMinMs: number | undefined;
    let runDurationMaxMs: number | undefined;

    let totalAttempts = 0;
    let retriedRows = 0;
    let retriedAttempts = 0;

    const failureCodeCounts: Record<string, number> = {};

    for (const row of trace) {
      statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;

      totalAttempts += row.attempt;
      if (row.attempt > 1) {
        retriedRows += 1;
        retriedAttempts += row.attempt - 1;
      }

      const queueWaitMs = this.safeDurationMs(row.createdAt, row.claimedAt);
      if (queueWaitMs !== null) {
        queueWaitTotalMs += queueWaitMs;
        queueWaitCount += 1;
        queueWaitMinMs = queueWaitMinMs === undefined
          ? queueWaitMs
          : Math.min(queueWaitMinMs, queueWaitMs);
        queueWaitMaxMs = queueWaitMaxMs === undefined
          ? queueWaitMs
          : Math.max(queueWaitMaxMs, queueWaitMs);
      }

      const runDurationMs = this.safeDurationMs(row.claimedAt, row.completedAt);
      if (runDurationMs !== null) {
        runDurationTotalMs += runDurationMs;
        runDurationCount += 1;
        runDurationMinMs = runDurationMinMs === undefined
          ? runDurationMs
          : Math.min(runDurationMinMs, runDurationMs);
        runDurationMaxMs = runDurationMaxMs === undefined
          ? runDurationMs
          : Math.max(runDurationMaxMs, runDurationMs);
      }

      if (row.errorCode) {
        failureCodeCounts[row.errorCode] = (failureCodeCounts[row.errorCode] ?? 0) + 1;
      }
    }

    return {
      statusCounts,
      totalRows: trace.length,
      totalAttempts,
      retriedRows,
      retriedAttempts,
      queueWaitMs: {
        count: queueWaitCount,
        ...(queueWaitCount > 0 ? {
          averageMs: Math.round(queueWaitTotalMs / queueWaitCount),
          minMs: queueWaitMinMs,
          maxMs: queueWaitMaxMs,
        } : {}),
      },
      runDurationMs: {
        count: runDurationCount,
        ...(runDurationCount > 0 ? {
          averageMs: Math.round(runDurationTotalMs / runDurationCount),
          minMs: runDurationMinMs,
          maxMs: runDurationMaxMs,
        } : {}),
      },
      failureCodeCounts,
    };
  }

  private safeDurationMs(start: string | undefined, end: string | undefined): number | null {
    if (!start || !end) {
      return null;
    }
    const startAt = Date.parse(start);
    const endAt = Date.parse(end);
    if (Number.isNaN(startAt) || Number.isNaN(endAt) || endAt < startAt) {
      return null;
    }
    return endAt - startAt;
  }

  private broadcastProgress(idempotencyKey: string, event: StudioTurnEvent) {
    const waiters = this.getWaiters(idempotencyKey);
    for (const waiter of waiters) {
      if (waiter.settled) {
        continue;
      }
      waiter.onProgress(event);
    }
  }

  private broadcastSend(idempotencyKey: string, envelope: unknown) {
    const waiters = this.getWaiters(idempotencyKey);
    for (const waiter of waiters) {
      if (waiter.settled) {
        continue;
      }
      waiter.send(envelope);
    }
  }

  private toCompletionFromResult(
    row: StudioDueRunRecord,
    turnOutcome: StudioTurnResult['outcome'],
  ): LocalStudioDueRunCompletion {
    if (turnOutcome.outcome === 'done') {
      return {
        runId: row.runId,
        conversationId: row.conversationId,
        idempotencyKey: row.identity.idempotencyKey,
        workdir: row.workdir,
        outcome: 'done',
        reply: turnOutcome.reply,
        // Legacy rows used finalDispatchId before Studio standardized on finalPetRunId.
        finalPetRunId: turnOutcome.finalPetRunId ?? row.finalPetRunId ?? row.finalDispatchId,
      };
    }

    return {
      runId: row.runId,
      conversationId: row.conversationId,
      idempotencyKey: row.identity.idempotencyKey,
      workdir: row.workdir,
      outcome: 'stopped',
      reply: turnOutcome.reply,
      reason: turnOutcome.reason,
    };
  }

  private toCompletionFromTerminalRow(row: StudioDueRunRecord): LocalStudioDueRunCompletion {
    if (row.status === 'success') {
      return {
        runId: row.runId,
        conversationId: row.conversationId,
        idempotencyKey: row.identity.idempotencyKey,
        workdir: row.workdir,
        outcome: 'done',
        reply: row.reply ?? '',
        // Keep reading finalDispatchId only as a legacy row migration fallback.
        finalPetRunId: row.finalPetRunId ?? row.finalDispatchId,
      };
    }

    const reason = row.errorDetail ?? row.errorCode ?? `studio run finished with status ${row.status}`;
    return {
      runId: row.runId,
      conversationId: row.conversationId,
      idempotencyKey: row.identity.idempotencyKey,
      workdir: row.workdir,
      outcome: 'stopped',
      reply: row.reply ?? '',
      reason,
    };
  }

}
