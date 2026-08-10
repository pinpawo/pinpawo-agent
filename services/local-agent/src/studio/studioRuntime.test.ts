import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildStudioForTurn, StudioNotConfiguredError } from './studioRuntime';
import { createPendingReviewSlot } from './studioBridge';
import { createTestModelProfiles } from '../testing/modelProfiles';
import { FileSaver } from '../fileSaver';
import { loadGeneralCapability } from '../capabilities/general';
async function mkTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const modelProfiles = createTestModelProfiles({
  apiKey: 'test-key',
  baseUrl: 'http://127.0.0.1:1/v1',
  model: 'gpt-test',
});

const baselineCapabilities = () => {
  const general = loadGeneralCapability();
  assert.ok(general);
  return [general];
};

test('buildStudioForTurn requires the workdir-scoped Studio config', async () => {
  const workdir = await mkTempDir('pinpawo-studio-runtime-missing-');
  const expectedConfigPath = path.join(workdir, '.pinpawo', 'studio.json');

  await assert.rejects(
    () => buildStudioForTurn({
      modelProfiles,
      capabilities: [],
      ownerUserId: null,
      workdir,
      bridge: {
        send: () => {},
        requestId: 'req-missing',
        slot: createPendingReviewSlot(),
      },
    }),
    (error: unknown) => error instanceof StudioNotConfiguredError
      && error.configPath === expectedConfigPath,
  );
});

test('buildStudioForTurn defaults Studio paths from effective runtime workdir', async () => {
  const previousWorkdir = process.env.PINPAWO_WORKDIR;
  const workdir = await mkTempDir('pinpawo-studio-runtime-workdir-');
  const stateRoot = path.join(workdir, '.pinpawo');
  await fs.mkdir(path.join(stateRoot, 'pets'), { recursive: true });
  await fs.writeFile(
    path.join(stateRoot, 'studio.json'),
    JSON.stringify({
      studioId: 'studio-runtime-default',
      plannerPetId: 'planner',
      agents: ['planner'],
    }),
    'utf8',
  );
  await fs.writeFile(
    path.join(stateRoot, 'pets', 'planner.json'),
    JSON.stringify({
      petId: 'planner',
      name: 'Planner',
      capabilities: [],
    }),
    'utf8',
  );

  process.env.PINPAWO_WORKDIR = workdir;
  try {
    const result = await buildStudioForTurn({
      modelProfiles,
      capabilities: baselineCapabilities(),
      ownerUserId: null,
      bridge: {
        send: () => {},
        requestId: 'req-1',
        slot: createPendingReviewSlot(),
      },
    });

    assert.equal(result.resolved.studio.studioId, 'studio-runtime-default');
    assert.deepEqual(result.resolved.agents.map((agent) => agent.petId), ['planner']);

    assert.equal(result.resolved.planner.petId, 'planner');
  } finally {
    if (previousWorkdir === undefined) {
      delete process.env.PINPAWO_WORKDIR;
    } else {
      process.env.PINPAWO_WORKDIR = previousWorkdir;
    }
  }
});

test('buildStudioForTurn prefers explicit workdir over env default', async () => {
  const previousWorkdir = process.env.PINPAWO_WORKDIR;
  const envWorkdir = await mkTempDir('pinpawo-studio-runtime-env-');
  const explicitWorkdir = await mkTempDir('pinpawo-studio-runtime-explicit-');
  const explicitStateRoot = path.join(explicitWorkdir, '.pinpawo');
  await fs.mkdir(path.join(envWorkdir, '.pinpawo', 'pets'), { recursive: true });
  await fs.mkdir(path.join(explicitStateRoot, 'pets'), { recursive: true });

  await fs.writeFile(
    path.join(envWorkdir, '.pinpawo', 'studio.json'),
    JSON.stringify({
      studioId: 'studio-runtime-env',
      plannerPetId: 'planner-env',
      agents: ['planner-env'],
    }),
    'utf8',
  );
  await fs.writeFile(
    path.join(envWorkdir, '.pinpawo', 'pets', 'planner-env.json'),
    JSON.stringify({
      petId: 'planner-env',
      name: 'PlannerEnv',
      capabilities: [],
    }),
    'utf8',
  );

  await fs.writeFile(
    path.join(explicitStateRoot, 'studio.json'),
    JSON.stringify({
      studioId: 'studio-runtime-explicit',
      plannerPetId: 'planner-explicit',
      agents: ['planner-explicit'],
    }),
    'utf8',
  );
  await fs.writeFile(
    path.join(explicitStateRoot, 'pets', 'planner-explicit.json'),
    JSON.stringify({
      petId: 'planner-explicit',
      name: 'PlannerExplicit',
      capabilities: [],
    }),
    'utf8',
  );

  process.env.PINPAWO_WORKDIR = envWorkdir;
  try {
    const result = await buildStudioForTurn({
      modelProfiles,
      capabilities: baselineCapabilities(),
      ownerUserId: null,
      workdir: explicitWorkdir,
      bridge: {
        send: () => {},
        requestId: 'req-2',
        slot: createPendingReviewSlot(),
      },
    });

    assert.equal(result.resolved.studio.studioId, 'studio-runtime-explicit');
    assert.deepEqual(result.resolved.agents.map((agent) => agent.petId), ['planner-explicit']);
  } finally {
    if (previousWorkdir === undefined) {
      delete process.env.PINPAWO_WORKDIR;
    } else {
      process.env.PINPAWO_WORKDIR = previousWorkdir;
    }
  }
});

test('buildStudioForTurn hands the host checkpointer to the assembled pets', async () => {
  // #613:此前从不传 checkpoint,pet 的 graph 跑在无 checkpoint 状态。
  const workdir = await mkTempDir('pinpawo-studio-checkpointer-');
  const stateRoot = path.join(workdir, '.pinpawo');
  await fs.mkdir(path.join(stateRoot, 'pets'), { recursive: true });
  await fs.writeFile(
    path.join(stateRoot, 'studio.json'),
    JSON.stringify({
      studioId: 'studio-cp',
      plannerPetId: 'planner',
      agents: ['planner', 'worker'],
    }),
    'utf8',
  );
  for (const petId of ['planner', 'worker']) {
    await fs.writeFile(
      path.join(stateRoot, 'pets', `${petId}.json`),
      JSON.stringify({ petId, name: petId, capabilities: [] }),
      'utf8',
    );
  }

  const checkpoint = new FileSaver(path.join(stateRoot, 'studio-cp.json'));
  const result = await buildStudioForTurn({
    modelProfiles,
    capabilities: baselineCapabilities(),
    ownerUserId: null,
    workdir,
    checkpoint,
    bridge: {
      send: () => {},
      requestId: 'req-cp',
      slot: createPendingReviewSlot(),
    },
  });

  // 断言的是"每个 pet 实际拿到什么",而不是回显入参。
  assert.deepEqual(
    [...result.petCheckpointers.keys()].sort(),
    ['planner', 'worker'],
  );
  for (const [petId, saver] of result.petCheckpointers) {
    assert.equal(saver, checkpoint, `pet ${petId} must receive the host checkpointer`);
  }
  assert.deepEqual(
    result.resolved.agents.map((agent) => agent.petId),
    ['planner', 'worker'],
  );
});

test('concurrent pets write isolated checkpoint threads', async () => {
  // V1 的并发目标形态是"不同 pet 并行",共用一个 checkpointer 的前提是
  // 各自 thread 互不覆盖。
  const dir = await mkTempDir('pinpawo-studio-cp-threads-');
  const checkpoint = new FileSaver(path.join(dir, 'cp.json'));
  const write = (threadId: string, n: number) => checkpoint.put(
    { configurable: { thread_id: threadId } } as never,
    {
      v: 4,
      id: `${threadId}-${n}`,
      ts: new Date().toISOString(),
      channel_values: { n },
      channel_versions: {},
      versions_seen: {},
    } as never,
    { source: 'update', step: n, parents: {} } as never,
  );

  await Promise.all([
    ...Array.from({ length: 5 }, (_, i) => write('studio:s1:pet:planner:invocation:i1', i)),
    ...Array.from({ length: 5 }, (_, i) => write('studio:s1:pet:worker:invocation:i1', i)),
  ]);

  const planner = await checkpoint.getTuple(
    { configurable: { thread_id: 'studio:s1:pet:planner:invocation:i1' } } as never,
  );
  const worker = await checkpoint.getTuple(
    { configurable: { thread_id: 'studio:s1:pet:worker:invocation:i1' } } as never,
  );
  assert.ok(planner);
  assert.ok(worker);
  assert.notEqual(
    planner.config.configurable?.thread_id,
    worker.config.configurable?.thread_id,
  );
});
