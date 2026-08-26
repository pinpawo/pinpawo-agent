import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  GENERAL_CAPABILITY_NAME,
  defineInstructionDocument,
  type AgentCapability,
  ToolkitRuntimeManager,
  type CapabilityArtifactStore,
} from '@pinpawo/pet-agent';

import { buildStudio, resolveStudioHostConfig } from '@pinpawo/studio';
import {
  buildLocalAgentRuntimeConfig,
  FileSaver,
  loadCapabilityDirectory,
} from 'pinpawo/host-runtime';
import { createTestModelProfileRegistry } from '../../../services/local-agent/src/testing/modelProfiles';
import {
  buildHostToolkitInventory,
  HostToolkitInventoryStore,
} from '../../../services/local-agent/src/toolkits/toolkitInventory';
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

const artifactStore: CapabilityArtifactStore = {
  writeArtifact: async () => { throw new Error('not used'); },
  readArtifact: async () => { throw new Error('not used'); },
  listArtifacts: async () => [],
  deleteThreadArtifacts: async () => undefined,
  getDownloadUri: async (uri) => uri,
};

async function residentBuildResources(workdir: string, plugins: ReturnType<typeof createKanbanPlugin>[]) {
  const runtimeConfig = buildLocalAgentRuntimeConfig(workdir);
  const toolkitInventory = new HostToolkitInventoryStore(await buildHostToolkitInventory({
    sources: [{
      id: 'plugins',
      kind: 'plugin',
      definitions: plugins.flatMap((plugin) => plugin.toolkits),
    }],
    resolveAvailability: async () => ({ available: true }),
  }));
  return {
    toolkitInventory,
    toolkitRuntimeManager: new ToolkitRuntimeManager(),
    capabilityArtifactStore: artifactStore,
    checkpoint: new FileSaver(path.join(runtimeConfig.stateRoot, 'test-checkpoints.json')),
    runtimeConfig,
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
    }),
  );
  if (withPlanningCapability) {
    const capabilityDir = path.join(
      stateRoot,
      'pets',
      'planner',
      'capabilities',
      'studio-planning',
    );
    await mkdir(capabilityDir, { recursive: true });
    await writeFile(path.join(capabilityDir, 'CAPABILITY.md'), `---
name: studio_planning
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

test('a Pet capability directory containing studio_planning reaches the kanban tools', async () => {
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
  const built = await buildStudio({
    configuration,
    modelProfiles: createTestModelProfileRegistry([{ modelProfileId: 'default' }]),
    hostCapabilities: [generalCapability()],
    petCapabilities: new Map([[
      'planner',
      loaded.map(({ capability }) => capability),
    ]]),
    ...await residentBuildResources(workdir, configuration.plugins as ReturnType<typeof createKanbanPlugin>[]),
  });
  const { studio } = built;

  const planner = studio.listPets().find((pet) => pet.petId === 'planner');
  assert.ok(planner, 'planner must be assembled');

  assert.equal(built.residentPets.size, 1);
  await studio.shutdown();
  await Promise.all([...built.residentPets.values()].map((resident) => resident.close()));
});

test('studio_planning is absent when the Pet capability directory is empty', async () => {
  const workdir = await writeStudioWorkdir(false);
  const configuration = await resolveStudioHostConfig({
    workdir,
    resolvePlugin: () => createKanbanPlugin(),
  });

  const built = await buildStudio({
    configuration,
    modelProfiles: createTestModelProfileRegistry([{ modelProfileId: 'default' }]),
    hostCapabilities: [generalCapability()],
    petCapabilities: new Map(),
    ...await residentBuildResources(workdir, configuration.plugins as ReturnType<typeof createKanbanPlugin>[]),
  });
  const { studio } = built;

  const planner = studio.listPets().find((pet) => pet.petId === 'planner');
  assert.ok(planner);
  assert.equal(built.residentPets.size, 1);
  await studio.shutdown();
  await Promise.all([...built.residentPets.values()].map((resident) => resident.close()));
});
