import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';
import { tool } from '@langchain/core/tools';

import { buildStudio } from './buildStudio';
import { createTestModelProfileRegistry } from '../../../../services/local-agent/src/testing/modelProfiles';
import {
  GENERAL_CAPABILITY_NAME,
  defineInstructionDocument,
  type AgentCapability,
} from '@pinpawo/pet-agent';

/** 插件即 toolkit:必须有 description 与至少一个 tool。 */
function fakePlugin() {
  return {
    name: 'kanban',
    description: 'Fake plugin.',
    tools: [{
      tool: tool(async () => 'ok', {
        name: 'kanban_noop',
        description: 'No-op test tool.',
        schema: z.object({}),
      }),
    }],
  } as never;
}

/** buildStudio 要求宿主提供 baseline capability。 */
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
    JSON.stringify({ petId: 'planner', name: 'Planner', role: 'planner', capabilities: [] }),
  );
  await writeFile(
    path.join(stateRoot, 'studio.json'),
    JSON.stringify({ studioId: 'demo', entryPetId: 'planner', pets: ['planner'], plugins }),
  );
  return root;
}

test('module options from studio.json reach the injected resolver', async () => {
  const workdir = await writeStudioConfig([
    { id: 'kanban', options: { timezone: 'Asia/Shanghai' } },
  ]);

  const seen: unknown[] = [];
  const result = await buildStudio({
    workdir,
    modelProfiles: createTestModelProfileRegistry([{ modelProfileId: 'default' }]),
    capabilities: [generalCapability()],
    toolkits: [],
    ownerUserId: null,
    resolveModule: (id, options) => {
      assert.equal(id, 'kanban');
      seen.push(options);
      return { plugin: fakePlugin() };
    },
  });

  assert.equal(result.plugins.length, 1);
  assert.deepEqual(seen, [{ timezone: 'Asia/Shanghai' }]);
});

test('a plugin declared without options still builds', async () => {
  const workdir = await writeStudioConfig([{ id: 'kanban' }]);

  const seen: unknown[] = [];
  await buildStudio({
    workdir,
    modelProfiles: createTestModelProfileRegistry([{ modelProfileId: 'default' }]),
    capabilities: [generalCapability()],
    toolkits: [],
    ownerUserId: null,
    resolveModule: (id, options) => {
      assert.equal(id, 'kanban');
      seen.push(options);
      return { plugin: fakePlugin() };
    },
  });

  assert.deepEqual(seen, [undefined]);
});

test('an optional module cannot shadow a Host capability', async () => {
  const workdir = await writeStudioConfig([{ id: 'unsafe-module' }]);

  await assert.rejects(() => buildStudio({
    workdir,
    modelProfiles: createTestModelProfileRegistry([{ modelProfileId: 'default' }]),
    capabilities: [generalCapability()],
    toolkits: [],
    ownerUserId: null,
    resolveModule: () => ({
      plugin: fakePlugin(),
      capabilities: [generalCapability()],
    }),
  }), /duplicate capability "general" contributed by optional module "unsafe-module"/);
});
