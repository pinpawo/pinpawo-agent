import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';
import { tool } from '@langchain/core/tools';

import {
  buildStudio,
  resolveStudioHostConfig,
  selectStudioPetCapabilities,
} from './buildStudio';
import { createTestModelProfileRegistry } from '../../../../services/host/src/testing/modelProfiles';
import {
  GENERAL_CAPABILITY_NAME,
  defineInstructionDocument,
  type AgentCapability,
  type AgentToolkit,
  type CapabilityArtifactStore,
} from '@pinpawo/pet-agent';
import type { StudioPlugin } from '../studioContract';
import {
  buildHostRuntimeConfig,
  FileSaver,
} from 'pinpawo/host-runtime';
import { HostToolkitInventoryStore } from '../../../../services/host/src/toolkits/toolkitInventory';

function fakePlugin(name = 'example-work'): StudioPlugin {
  const toolkit: AgentToolkit = {
    name: 'example-work-toolkit',
    description: 'Fake plugin.',
    tools: [{
      tool: tool(async () => 'ok', {
        name: 'example-work_noop',
        description: 'No-op test tool.',
        schema: z.object({}),
      }),
    }],
  };
  return {
    name,
    toolkits: [toolkit],
    start: () => undefined,
  };
}

/** buildStudio requires the Agent Host baseline Capability. */
function generalCapability(): AgentCapability {
  return {
    name: GENERAL_CAPABILITY_NAME,
    description: 'Baseline capability for tests.',
    uses: [],
    instructions: defineInstructionDocument({ content: '# General' }),
  };
}

test('an explicit Pet default excludes the general fallback Capability', () => {
  const specialist: AgentCapability = {
    name: 'studio_planning',
    description: 'Plan Studio work.',
    uses: [],
    instructions: defineInstructionDocument({ content: '# Studio planning' }),
  };

  assert.deepEqual(
    selectStudioPetCapabilities({
      defaultCapabilityName: 'studio_planning',
      generalCapability: generalCapability(),
      petCapabilities: [specialist],
    }).map(({ name }) => name),
    ['studio_planning'],
  );
  assert.deepEqual(
    selectStudioPetCapabilities({
      generalCapability: generalCapability(),
      petCapabilities: [specialist],
    }).map(({ name }) => name),
    ['general', 'studio_planning'],
  );
});

const artifactStore: CapabilityArtifactStore = {
  writeArtifact: async () => { throw new Error('not used'); },
  readArtifact: async () => { throw new Error('not used'); },
  listArtifacts: async () => [],
  deleteThreadArtifacts: async () => undefined,
  getDownloadUri: async (uri) => uri,
};

function residentBuildResources(workdir: string) {
  const runtimeConfig = buildHostRuntimeConfig(workdir);
  return {
    toolkitInventory: new HostToolkitInventoryStore(),
    capabilityArtifactStore: artifactStore,
    checkpoint: new FileSaver(path.join(runtimeConfig.stateRoot, 'test-checkpoints.json')),
    runtimeConfig,
    toolAuthorizationMode: 'require_authorization' as const,
    autoAuthorizationSafetyLevel: 'strict' as const,
  };
}

/**
 * 插件 options 透传。schema 与文档都承诺「studio 原样透传,由插件自己解释」,
 * 但装配时曾只解构 id 并调用无参 factory —— 用户配置解析成功却完全不生效。
 */
async function writeStudioConfig(plugins: unknown[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-build-studio-'));
  const stateRoot = path.join(root, '.pinpawo');
  await mkdir(path.join(stateRoot, 'pets'), { recursive: true });
  await writeFile(
    path.join(stateRoot, 'pets', 'planner.json'),
    JSON.stringify({ definitionId: 'planner', name: 'Planner' }),
  );
  await writeFile(
    path.join(stateRoot, 'studio.json'),
    JSON.stringify({ studioId: 'demo', definitions: ['planner'], plugins }),
  );
  return root;
}

test('a Host-selected shared Capability can serve as a resident Pet default', async () => {
  const workdir = await writeStudioConfig([]);
  const capability: AgentCapability = { ...generalCapability(), name: 'shared_context' };
  await writeFile(path.join(workdir, '.pinpawo', 'pets', 'planner.json'), JSON.stringify({
    definitionId: 'planner', name: 'Planner', defaultCapabilityName: capability.name,
    sharedCapabilities: [capability.name],
  }));
  const configuration = await resolveStudioHostConfig({ workdir });
  const input = {
    configuration,
    modelProfiles: createTestModelProfileRegistry([{ modelProfileId: 'default' }]),
    hostCapabilities: [generalCapability()], petCapabilities: new Map([['planner', [capability]]]),
    ...residentBuildResources(workdir),
  };
  const { studio, residentPets } = await buildStudio(input);
  try {
    await studio.pets.create({ petId: 'planner', definitionId: 'planner', name: 'Planner' });
    assert.ok(residentPets.has('planner'));
  } finally { await studio.shutdown(); }
  await assert.rejects(buildStudio({ ...input, petCapabilities: new Map() }), /default Capability .* is not available/);
});

test('plugin options from studio.json reach the injected resolver', async () => {
  const workdir = await writeStudioConfig([
    { id: 'example-work', options: { timezone: 'Asia/Shanghai' } },
  ]);

  const seen: unknown[] = [];
  const configuration = await resolveStudioHostConfig({
    workdir,
    resolvePlugin: (id, options) => {
      assert.equal(id, 'example-work');
      seen.push(options);
      return fakePlugin();
    },
  });
  const result = await buildStudio({
    configuration,
    modelProfiles: createTestModelProfileRegistry([{ modelProfileId: 'default' }]),
    hostCapabilities: [generalCapability()],
    petCapabilities: new Map(),
    ...residentBuildResources(workdir),
  });

  assert.equal(result.plugins.length, 1);
  assert.deepEqual(seen, [{ timezone: 'Asia/Shanghai' }]);
});

test('buildStudio wires a Plugin context provider into new and restored resident Pet Hosts', async () => {
  const workdir = await writeStudioConfig([{ id: 'context-owner' }]);
  const targets: unknown[] = [];
  const plugin: StudioPlugin = {
    name: 'context-owner', toolkits: [], contextNamespaces: ['project'],
    start(context) {
      context.registerContextProvider('project', async (target) => {
        targets.push(target);
        // Stop before any model call; this checks the real Host's admission
        // bridge, not a mock dispatch adapter or a paid model request.
        throw new Error('observed real Host context resolution');
      });
    },
  };
  const configuration = await resolveStudioHostConfig({ workdir, resolvePlugin: () => plugin });
  const make = () => buildStudio({
    configuration,
    modelProfiles: createTestModelProfileRegistry([{ modelProfileId: 'default' }]),
    hostCapabilities: [generalCapability()],
    petCapabilities: new Map(),
    ...residentBuildResources(workdir),
  });
  const first = await make();
  try {
    await first.studio.pets.create({ petId: 'planner', definitionId: 'planner', name: 'Planner' });
    await assert.rejects(first.studio.dispatch({
      petId: 'planner', request: 'new resident', session: { id: 'planner:00000001', create: true },
      scope: { namespace: 'project', id: 'first' },
    }), /observed real Host context resolution/);
  } finally {
    await first.studio.shutdown();
  }
  const restored = await make();
  try {
    assert.deepEqual(restored.studio.listPets().map(({ petId }) => petId), ['planner']);
    await assert.rejects(restored.studio.dispatch({
      petId: 'planner', request: 'restored resident', session: { id: 'planner:00000002', create: true },
      scope: { namespace: 'project', id: 'second' },
    }), /observed real Host context resolution/);
    assert.deepEqual(targets, [
      { petId: 'planner', sessionId: 'planner:00000001', scope: { namespace: 'project', id: 'first' } },
      { petId: 'planner', sessionId: 'planner:00000002', scope: { namespace: 'project', id: 'second' } },
    ]);
  } finally {
    await restored.studio.shutdown();
  }
});

test('a plugin declared without options still builds', async () => {
  const workdir = await writeStudioConfig([{ id: 'example-work' }]);

  const seen: unknown[] = [];
  const configuration = await resolveStudioHostConfig({
    workdir,
    resolvePlugin: (id, options) => {
      assert.equal(id, 'example-work');
      seen.push(options);
      return fakePlugin();
    },
  });
  await buildStudio({
    configuration,
    modelProfiles: createTestModelProfileRegistry([{ modelProfileId: 'default' }]),
    hostCapabilities: [generalCapability()],
    petCapabilities: new Map(),
    ...residentBuildResources(workdir),
  });

  assert.deepEqual(seen, [undefined]);
});

test('a resolved plugin must define its Toolkit list', async () => {
  const workdir = await writeStudioConfig([{ id: 'broken' }]);

  await assert.rejects(() => resolveStudioHostConfig({
    workdir,
    resolvePlugin: () => ({
      name: 'broken',
      start: () => undefined,
    } as unknown as StudioPlugin),
  }), /plugin "broken" must define a Toolkit list/);
});

test('one Plugin id may resolve multiple uniquely named instances', async () => {
  const workdir = await writeStudioConfig([
    { id: 'scheduler', options: { instance: 'morning' } },
    { id: 'scheduler', options: { instance: 'evening' } },
  ]);

  const configuration = await resolveStudioHostConfig({
    workdir,
    resolvePlugin: (_id, options) => fakePlugin(`scheduler-${String(options?.instance)}`),
  });

  assert.deepEqual(
    configuration.plugins.map(({ name }) => name),
    ['scheduler-morning', 'scheduler-evening'],
  );
});

test('multiple Plugin instances must resolve to unique names', async () => {
  const workdir = await writeStudioConfig([
    { id: 'scheduler', options: { instance: 'morning' } },
    { id: 'scheduler', options: { instance: 'evening' } },
  ]);

  await assert.rejects(
    () => resolveStudioHostConfig({
      workdir,
      resolvePlugin: () => fakePlugin('scheduler'),
    }),
    /duplicate plugin "scheduler"/,
  );
});

test('Capability names are scoped per Pet rather than globally across Studio', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-pet-capability-scope-'));
  const stateRoot = path.join(root, '.pinpawo');
  await mkdir(path.join(stateRoot, 'pets'), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(stateRoot, 'pets', 'planner.json'),
      JSON.stringify({ definitionId: 'planner', name: 'Planner' }),
    ),
    writeFile(
      path.join(stateRoot, 'pets', 'writer.json'),
      JSON.stringify({ definitionId: 'writer', name: 'Writer' }),
    ),
    writeFile(
      path.join(stateRoot, 'studio.json'),
      JSON.stringify({
        studioId: 'scoped',
        definitions: ['planner', 'writer'],
      }),
    ),
  ]);
  const configuration = await resolveStudioHostConfig({ workdir: root });
  const scoped = (description: string): AgentCapability => ({
    name: 'shared_name',
    description,
    uses: [],
    instructions: defineInstructionDocument({ content: `# ${description}` }),
  });

  const { studio } = await buildStudio({
    configuration,
    modelProfiles: createTestModelProfileRegistry([{ modelProfileId: 'default' }]),
    hostCapabilities: [generalCapability()],
    petCapabilities: new Map([
      ['planner', [scoped('Planner definition')]],
      ['writer', [scoped('Writer definition')]],
    ]),
    ...residentBuildResources(root),
  });
  assert.deepEqual(studio.listPets(), []);
  await studio.pets.create({ petId: 'planner', definitionId: 'planner', name: 'Planner' });
  await studio.pets.create({ petId: 'writer', definitionId: 'writer', name: 'Writer' });
  assert.deepEqual(studio.listPets().map(({ petId }) => petId), ['planner', 'writer']);
  await studio.shutdown();
});
