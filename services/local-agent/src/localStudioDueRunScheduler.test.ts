import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryStudioDueRunStore } from '@pinpawo/pet-agent';
import type { StudioTurnResult } from '@pinpawo/pet-agent';
import type { LocalServerDeps } from './localServerTypes';
import { LocalStudioDueRunScheduler } from './localStudioDueRunScheduler';
import type { BuildStudioInput, BuildStudioResult } from './studio/studioRuntime';
import { StudioRunService } from './studioRunService';

function createRuntimeConfig(workdir: string) {
  return {
    workdir,
    stateRoot: `${workdir}/.pinpawo`,
    studioConfigPath: `${workdir}/.pinpawo/studio.json`,
    studioDueRunsPath: `${workdir}/.pinpawo/studio-due-runs.json`,
    petsDir: `${workdir}/.pinpawo/pets`,
    studioWikiBaseDir: `${workdir}/.pinpawo/studio-wiki`,
    checkpointPath: `${workdir}/.pinpawo/checkpoints.json`,
    tuiCheckpointPath: `${workdir}/.pinpawo/checkpoints-tui.json`,
    tuiSessionPath: `${workdir}/.pinpawo/tui-sessions.json`,
    capabilityArtifactRoot: `${workdir}/.pinpawo/capability-artifacts`,
  };
}

function createDeps(workdir: string): LocalServerDeps {
  return {
    actorId: 'pet-a',
    llmConfig: {
      provider: 'openai',
      model: 'test-model',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
    } as LocalServerDeps['llmConfig'],
    workdir,
    runtimeConfig: createRuntimeConfig(workdir),
  };
}

function createStudioRunService(onRunStart?: () => void): StudioRunService {
  const buildStudio = async (_input: BuildStudioInput): Promise<BuildStudioResult> => {
    onRunStart?.();
    return {
      resolved: {} as BuildStudioResult['resolved'],
      orchestrator: {
        invoke: async (turn: {
          onTurnEvent?: (event: { type: string }) => void;
          onToolEvent?: (event: unknown) => void;
          conversationId?: string;
          turnId?: string;
        }) => {
          turn.onTurnEvent?.({ type: 'turn_started' });
          return {
            turnId: turn.turnId ?? 'run',
            state: {},
            outcome: {
              outcome: 'done',
              reply: 'done',
              finalDispatchId: 'dispatch-1',
            },
            studio: {} as StudioTurnResult['studio'],
          } as StudioTurnResult;
        },
      } as unknown as BuildStudioResult['orchestrator'],
    };
  };

  return new StudioRunService({ buildStudio });
}

test('LocalStudioDueRunScheduler deduplicates concurrent submissions for same idempotency key', async () => {
  let runServiceCalls = 0;
  const scheduler = new LocalStudioDueRunScheduler({
    store: new InMemoryStudioDueRunStore(),
    studioRunService: createStudioRunService(() => {
      runServiceCalls += 1;
    }),
  });
  const slot = { current: null };
  const deps = createDeps('/tmp/wd-dedup');
  const submitOptions = {
    deps,
    runId: 'shared-run',
    conversationId: 'shared-conv',
    userRequest: 'build page',
    onProgress: () => undefined,
    onToolEvent: () => undefined,
    send: () => undefined,
    slot,
  };

  const [first, second, third] = await Promise.all([
    scheduler.submit({
      ...submitOptions,
      requestId: 'request-1',
    }),
    scheduler.submit({
      ...submitOptions,
      requestId: 'request-2',
    }),
    scheduler.submit({
      ...submitOptions,
      requestId: 'request-3',
    }),
  ]);

  assert.equal(first.outcome, 'done');
  assert.equal(second.outcome, 'done');
  assert.equal(third.outcome, 'done');
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.equal(first.idempotencyKey, third.idempotencyKey);
  assert.equal(runServiceCalls, 1);
  assert.equal(first.workdir, '/tmp/wd-dedup');
  assert.equal(first.finalDispatchId, 'dispatch-1');
  scheduler.stop();
});

test('LocalStudioDueRunScheduler applies workdir claim filter and does not execute foreign rows', async () => {
  const runCalls: string[] = [];
  const scheduler = new LocalStudioDueRunScheduler({
    store: new InMemoryStudioDueRunStore(),
    studioRunService: createStudioRunService(() => runCalls.push('started')),
    filterWorkdir: '/tmp/wd-a',
    pollIntervalMs: 10,
  });

  const abortA = new AbortController();
  const abortB = new AbortController();
  const depsA = createDeps('/tmp/wd-a');
  const depsB = createDeps('/tmp/wd-b');
  const slotA = { current: null };
  const slotB = { current: null };
  const first = scheduler.submit({
    deps: depsA,
    requestId: 'request-a',
    runId: 'run-a',
    conversationId: 'conv-a',
    userRequest: 'run in a',
    onProgress: () => undefined,
    onToolEvent: () => undefined,
    send: () => undefined,
    slot: slotA,
    signal: abortA.signal,
  });
  const second = scheduler.submit({
    deps: depsB,
    requestId: 'request-b',
    runId: 'run-b',
    conversationId: 'conv-b',
    userRequest: 'run in b',
    onProgress: () => undefined,
    onToolEvent: () => undefined,
    send: () => undefined,
    slot: slotB,
    signal: abortB.signal,
  });

  abortB.abort();
  const firstResult = await first;
  await assert.rejects(() => second, /NotAllowedError|outside scheduler scope|aborted|AbortError/i);
  assert.equal(firstResult.runId, 'run-a');
  assert.deepEqual(runCalls, ['started']);
  scheduler.stop();
});

test('LocalStudioDueRunScheduler.submit rejects requests with non-matching workdir scope', async () => {
  const scheduler = new LocalStudioDueRunScheduler({
    store: new InMemoryStudioDueRunStore(),
    studioRunService: createStudioRunService(),
    filterWorkdir: '/tmp/wd-scope',
    pollIntervalMs: 10,
  });
  const depsWrongScope = createDeps('/tmp/wd-other');
  const slot = { current: null };

  await assert.rejects(() => scheduler.submit({
    deps: depsWrongScope,
    requestId: 'request-scope',
    runId: 'run-scope',
    conversationId: 'conv-scope',
    userRequest: 'bad scope',
    onProgress: () => undefined,
    onToolEvent: () => undefined,
    send: () => undefined,
    slot,
  }), /outside scheduler scope|NotAllowedError/i);
});

test('LocalStudioDueRunScheduler.stop rejects pending waiters', async () => {
  const scheduler = new LocalStudioDueRunScheduler({
    store: new InMemoryStudioDueRunStore(),
    studioRunService: createStudioRunService(),
    pollIntervalMs: 10,
  });

  const deps = createDeps('/tmp/wd-stop');
  const slot = { current: null };
  const pending = scheduler.submit({
    deps,
    requestId: 'request-stop',
    runId: 'run-stop',
    userRequest: 'stop me',
    onProgress: () => undefined,
    onToolEvent: () => undefined,
    send: () => undefined,
    slot,
  });

  scheduler.stop();
  await assert.rejects(() => pending, /aborted|AbortError/i);
});

test('LocalStudioDueRunScheduler.submit rejects immediately after stop', async () => {
  const scheduler = new LocalStudioDueRunScheduler({
    store: new InMemoryStudioDueRunStore(),
    studioRunService: createStudioRunService(),
  });
  scheduler.stop();

  const deps = createDeps('/tmp/wd-post-stop');
  const slot = { current: null };
  await assert.rejects(() => scheduler.submit({
    deps,
    requestId: 'request-post-stop',
    runId: 'run-post-stop',
    userRequest: 'stopped',
    onProgress: () => undefined,
    onToolEvent: () => undefined,
    send: () => undefined,
    slot,
  }), /aborted|AbortError/i);
});

test('LocalStudioDueRunScheduler.trace filters entries by configured workdir', async () => {
  const store = new InMemoryStudioDueRunStore();
  store.submit({
    runId: 'run-a',
    conversationId: 'conv-a',
    workdir: '/tmp/wd-a',
    userRequest: 'run in a',
  });
  store.submit({
    runId: 'run-b',
    conversationId: 'conv-b',
    workdir: '/tmp/wd-b',
    userRequest: 'run in b',
  });

  const scheduler = new LocalStudioDueRunScheduler({
    store,
    studioRunService: createStudioRunService(),
    filterWorkdir: ['/tmp/wd-a'],
  });
  const trace = await scheduler.trace();

  assert.deepEqual(trace.map((entry) => entry.runId), ['run-a']);
});

test('LocalStudioDueRunScheduler.metrics summarizes queue latency, run duration, failures, and retries', async () => {
  const baseTime = Date.parse('2026-06-19T00:00:00.000Z');
  let tick = 0;
  const now = () => new Date(baseTime + tick++ * 1000).toISOString();
  const store = new InMemoryStudioDueRunStore({ now });

  const runService = createStudioRunService();
  const scheduler = new LocalStudioDueRunScheduler({
    store,
    studioRunService: runService,
  });

  const rowA = store.submit({
    runId: 'run-success',
    conversationId: 'conv-success',
    workdir: '/tmp/wd-metrics',
    userRequest: 'success run',
    now: now(),
  });

  const claimA = store.claim(null);
  assert.ok(claimA);
  store.start(claimA);
  store.succeed(claimA, {
    finalDispatchId: 'dispatch-a',
    reply: 'ok',
  });

  const rowB = store.submit({
    runId: 'run-failed',
    conversationId: 'conv-failed',
    workdir: '/tmp/wd-metrics',
    userRequest: 'failed run',
    now: now(),
  });
  assert.equal(rowB.runId, 'run-failed');

  const claimB1 = store.claim(null);
  assert.ok(claimB1);
  store.start(claimB1);
  const failed = store.fail(claimB1, {
    errorCode: 'E_TEST',
    errorDetail: 'intentional',
  });

  store.retry(claimB1);
  const claimB2 = store.claim(null);
  assert.ok(claimB2);
  store.start(claimB2);
  store.fail(claimB2, {
    errorCode: 'E_TEST',
    errorDetail: 'still failing',
  });

  const metrics = await scheduler.metrics();

  assert.equal(metrics.totalRows, 2);
  assert.equal(metrics.totalAttempts, 3);
  assert.equal(metrics.retriedRows, 1);
  assert.equal(metrics.retriedAttempts, 1);
  assert.equal(metrics.statusCounts.success, 1);
  assert.equal(metrics.statusCounts.failed, 1);
  assert.equal(metrics.statusCounts.pending, 0);
  assert.equal(metrics.failureCodeCounts.E_TEST, 1);

  assert.equal(metrics.queueWaitMs.count, 2);
  assert.equal(metrics.queueWaitMs.minMs, 1000);
  assert.equal(metrics.queueWaitMs.maxMs, 6000);
  assert.equal(metrics.queueWaitMs.averageMs, 3500);

  assert.equal(metrics.runDurationMs.count, 1);
  assert.equal(metrics.runDurationMs.minMs, 2000);
  assert.equal(metrics.runDurationMs.maxMs, 2000);
  assert.equal(metrics.runDurationMs.averageMs, 2000);

  scheduler.stop();
});
