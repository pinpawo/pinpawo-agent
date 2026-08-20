import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  GENERAL_CAPABILITY_NAME,
  defineInstructionDocument,
  type AgentCapability,
} from '@pinpawo/pet-agent';

import { buildStudio } from '@pinpawo/studio';
import { createTestModelProfileRegistry } from '../../../services/local-agent/src/testing/modelProfiles';
import { createKanbanPlugin } from './kanbanPlugin';
import { loadStudioPlanningCapability } from './studioPlanningCapability';

/**
 * 真实装配路径的集成测试:studio.json + pets/*.json + kanban 插件 + buildStudio。
 *
 * 单测里手搓 compileAgentRegistry 证明不了这条 —— pet 的 Capability 由
 * `pets/<id>.json` 显式声明,能不能解析到 `studio_planning` 这个名字取决于
 * buildStudio 怎么组装 capabilitiesByName。
 */

function generalCapability(): AgentCapability {
  return {
    name: GENERAL_CAPABILITY_NAME,
    description: 'Baseline capability for tests.',
    uses: [],
    instructions: defineInstructionDocument({ content: '# General' }),
  };
}

async function writeStudioWorkdir(petCapabilities: string[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-planning-'));
  const stateRoot = path.join(root, '.pinpawo');
  await mkdir(path.join(stateRoot, 'pets'), { recursive: true });
  await writeFile(
    path.join(stateRoot, 'studio.json'),
    JSON.stringify({
      studioId: 'demo',
      entryPetId: 'planner',
      pets: ['planner'],
      plugins: [{ id: 'kanban' }],
    }),
  );
  await writeFile(
    path.join(stateRoot, 'pets', 'planner.json'),
    JSON.stringify({
      petId: 'planner',
      name: 'Planner',
      role: 'planner',
      capabilities: petCapabilities,
    }),
  );
  return root;
}

test('a pet that declares studio_planning resolves it and reaches the kanban tools', async () => {
  const workdir = await writeStudioWorkdir([GENERAL_CAPABILITY_NAME, 'studio_planning']);

  const { studio } = await buildStudio({
    workdir,
    modelProfiles: createTestModelProfileRegistry([{ modelProfileId: 'default' }]),
    capabilities: [generalCapability()],
    toolkits: [],
    ownerUserId: null,
    resolveModule: () => ({
      plugin: createKanbanPlugin(),
      capabilities: [loadStudioPlanningCapability()!],
    }),
  });

  const planner = studio.listPets().find((pet) => pet.petId === 'planner');
  assert.ok(planner, 'planner must be assembled');

  const planning = planner.capabilities.find((item) => item.name === 'studio_planning');
  assert.ok(planning, 'studio_planning must resolve through the studio assembly path');
  // 这是整条链的落点:kanban 插件已装配,所以这个能力是**可用的**,
  // 而不是 unavailable。
  assert.equal(planning.available, true, planning.reason ?? '');
});

test('studio_planning is not forced on pets that do not declare it', async () => {
  // 不隐式给所有 pet 注入 —— 装不装仍由 pet 配置决定。
  const workdir = await writeStudioWorkdir([GENERAL_CAPABILITY_NAME]);

  const { studio } = await buildStudio({
    workdir,
    modelProfiles: createTestModelProfileRegistry([{ modelProfileId: 'default' }]),
    capabilities: [generalCapability()],
    toolkits: [],
    ownerUserId: null,
    resolveModule: () => ({
      plugin: createKanbanPlugin(),
      capabilities: [loadStudioPlanningCapability()!],
    }),
  });

  const planner = studio.listPets().find((pet) => pet.petId === 'planner');
  assert.ok(planner);
  assert.equal(
    planner.capabilities.some((item) => item.name === 'studio_planning'),
    false,
  );
});
