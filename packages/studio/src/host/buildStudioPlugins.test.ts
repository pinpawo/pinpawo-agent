import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';
import { tool } from '@langchain/core/tools';

import { buildStudio, resolveStudioHostConfig } from './buildStudio';
import { createTestModelProfileRegistry } from '../../../../services/local-agent/src/testing/modelProfiles';
import {
  GENERAL_CAPABILITY_NAME,
  defineInstructionDocument,
  type AgentCapability,
  type AgentToolkit,
} from '@pinpawo/pet-agent';
import type { StudioPlugin } from '../studioContract';

function fakePlugin(name = 'kanban'): StudioPlugin {
  const toolkit: AgentToolkit = {
    name: 'kanban-toolkit',
    description: 'Fake plugin.',
    tools: [{
      tool: tool(async () => 'ok', {
        name: 'kanban_noop',
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
    JSON.stringify({ petId: 'planner', name: 'Planner', role: 'planner' }),
  );
  await writeFile(
    path.join(stateRoot, 'studio.json'),
    JSON.stringify({ studioId: 'demo', entryPetId: 'planner', pets: ['planner'], plugins }),
  );
  return root;
}

test('plugin options from studio.json reach the injected resolver', async () => {
  const workdir = await writeStudioConfig([
    { id: 'kanban', options: { timezone: 'Asia/Shanghai' } },
  ]);

  const seen: unknown[] = [];
  const configuration = await resolveStudioHostConfig({
    workdir,
    resolvePlugin: (id, options) => {
      assert.equal(id, 'kanban');
      seen.push(options);
      return fakePlugin();
    },
  });
  const result = await buildStudio({
    configuration,
    modelProfiles: createTestModelProfileRegistry([{ modelProfileId: 'default' }]),
    hostCapabilities: [generalCapability()],
    petCapabilities: new Map(),
    toolkits: configuration.plugins.flatMap((plugin) => plugin.toolkits),
    ownerUserId: null,
  });

  assert.equal(result.plugins.length, 1);
  assert.deepEqual(seen, [{ timezone: 'Asia/Shanghai' }]);
});

test('a plugin declared without options still builds', async () => {
  const workdir = await writeStudioConfig([{ id: 'kanban' }]);

  const seen: unknown[] = [];
  const configuration = await resolveStudioHostConfig({
    workdir,
    resolvePlugin: (id, options) => {
      assert.equal(id, 'kanban');
      seen.push(options);
      return fakePlugin();
    },
  });
  await buildStudio({
    configuration,
    modelProfiles: createTestModelProfileRegistry([{ modelProfileId: 'default' }]),
    hostCapabilities: [generalCapability()],
    petCapabilities: new Map(),
    toolkits: configuration.plugins.flatMap((plugin) => plugin.toolkits),
    ownerUserId: null,
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
      JSON.stringify({ petId: 'planner', name: 'Planner' }),
    ),
    writeFile(
      path.join(stateRoot, 'pets', 'writer.json'),
      JSON.stringify({ petId: 'writer', name: 'Writer' }),
    ),
    writeFile(
      path.join(stateRoot, 'studio.json'),
      JSON.stringify({
        studioId: 'scoped',
        entryPetId: 'planner',
        pets: ['planner', 'writer'],
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
    toolkits: [],
    ownerUserId: null,
  });

  const descriptions = new Map(studio.listPets().map((pet) => [
    pet.petId,
    pet.capabilities.find(({ name }) => name === 'shared_name')?.description,
  ]));
  assert.equal(descriptions.get('planner'), 'Planner definition');
  assert.equal(descriptions.get('writer'), 'Writer definition');
});
