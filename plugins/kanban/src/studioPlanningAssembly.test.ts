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

import { buildStudio, resolveStudioHostConfig } from '@pinpawo/studio';
import { loadCapabilityDirectory } from 'pinpawo/host-runtime';
import { createTestModelProfileRegistry } from '../../../services/local-agent/src/testing/modelProfiles';
import { createKanbanPlugin } from './kanbanPlugin';

/**
 * 真实装配路径的集成测试:studio.json + pets/*.json + kanban 插件 + buildStudio。
 *
 * 单测里手搓 compileAgentRegistry 证明不了这条 —— pet 的 Capability 来自
 * `pets/<id>/capabilities/`，必须沿真实目录 loader 和 buildStudio 装配路径验证。
 */

function generalCapability(): AgentCapability {
  return {
    name: GENERAL_CAPABILITY_NAME,
    description: 'Baseline capability for tests.',
    uses: [],
    instructions: defineInstructionDocument({ content: '# General' }),
  };
}

async function writeStudioWorkdir(withPlanningCapability: boolean): Promise<string> {
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
      ...(withPlanningCapability
        ? { defaultCapabilityName: 'kanban_planning' }
        : {}),
    }),
  );
  if (withPlanningCapability) {
    const capabilityDir = path.join(
      stateRoot,
      'pets',
      'planner',
      'capabilities',
      'kanban-planning',
    );
    await mkdir(capabilityDir, { recursive: true });
    await writeFile(path.join(capabilityDir, 'CAPABILITY.md'), `---
name: kanban_planning
description: "Plan and advance work through the shared board."
uses:
  - kanban
version: 1
---

# Studio planning

Use the kanban Toolkit to plan and advance assigned work.
`);
  }
  return root;
}

test('a Pet capability directory containing kanban_planning reaches the kanban tools', async () => {
  const workdir = await writeStudioWorkdir(true);
  const configuration = await resolveStudioHostConfig({
    workdir,
    resolvePlugin: () => createKanbanPlugin(),
  });

  const loaded = await loadCapabilityDirectory(path.join(
    workdir,
    '.pinpawo',
    'pets',
    'planner',
    'capabilities',
  ));
  const { studio } = await buildStudio({
    configuration,
    modelProfiles: createTestModelProfileRegistry([{ modelProfileId: 'default' }]),
    hostCapabilities: [generalCapability()],
    petCapabilities: new Map([[
      'planner',
      loaded.map(({ capability }) => capability),
    ]]),
    toolkits: configuration.plugins.flatMap((plugin) => plugin.toolkits),
    ownerUserId: null,
  });

  const planner = studio.listPets().find((pet) => pet.petId === 'planner');
  assert.ok(planner, 'planner must be assembled');

  const planning = planner.capabilities.find((item) => item.name === 'kanban_planning');
  assert.ok(planning, 'kanban_planning must resolve through the studio assembly path');
  // 这是整条链的落点:kanban 插件已装配,所以这个能力是**可用的**,
  // 而不是 unavailable。
  assert.equal(planning.available, true, planning.reason ?? '');
});

test('kanban_planning is absent when the Pet capability directory is empty', async () => {
  const workdir = await writeStudioWorkdir(false);
  const configuration = await resolveStudioHostConfig({
    workdir,
    resolvePlugin: () => createKanbanPlugin(),
  });

  const { studio } = await buildStudio({
    configuration,
    modelProfiles: createTestModelProfileRegistry([{ modelProfileId: 'default' }]),
    hostCapabilities: [generalCapability()],
    petCapabilities: new Map(),
    toolkits: configuration.plugins.flatMap((plugin) => plugin.toolkits),
    ownerUserId: null,
  });

  const planner = studio.listPets().find((pet) => pet.petId === 'planner');
  assert.ok(planner);
  assert.equal(
    planner.capabilities.some((item) => item.name === 'kanban_planning'),
    false,
  );
});
