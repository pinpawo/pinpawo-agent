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
  await assert.rejects(() => second, /aborted|AbortError/i);
  assert.equal(firstResult.runId, 'run-a');
  assert.deepEqual(runCalls, ['started']);
  scheduler.stop();
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
