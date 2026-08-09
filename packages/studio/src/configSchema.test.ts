import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigValue } from '@pinpawo/pet-agent';

import {
  petLocalConfigSchema,
  resolveStudio,
  studioLocalConfigSchema,
  type PetLocalConfig,
  type StudioLocalConfig,
} from './configSchema';

// schema 只负责结构;文件入口由宿主提供，因此这里直接喂已解析的值。
const parsePet = (raw: unknown, source: string): PetLocalConfig =>
  parseConfigValue(raw, petLocalConfigSchema, source);
const parseStudio = (raw: unknown, source: string): StudioLocalConfig =>
  parseConfigValue(raw, studioLocalConfigSchema, source);

function pet(petId: string, overrides: Partial<PetLocalConfig> = {}): PetLocalConfig {
  return {
    petId,
    name: `Pet ${petId}`,
    capabilities: [],
    ...overrides,
  };
}

test('parsePetLocalConfig accepts minimal valid config', () => {
  const config = parsePet(
    { petId: 'p1', name: 'Pet 1' },
    'test-source',
  );
  assert.equal(config.petId, 'p1');
  assert.equal(config.name, 'Pet 1');
  assert.deepEqual(config.capabilities, []);
  assert.equal(config.serverBinding, undefined);
});

test('parsePetLocalConfig keeps optional fields when provided', () => {
  const config = parsePet(
    {
      petId: 'p1',
      name: 'Script Pet',
      personality: '创意丰富',
      role: '脚本撰写',
      serviceSummary: '短视频脚本',
      modelProfileId: 'qwen-max',
      capabilities: ['script-creator', 'wiki-reader'],
      serverBinding: { petId: 'srv-001' },
    },
    'test-source',
  );
  assert.equal(config.personality, '创意丰富');
  assert.equal(config.modelProfileId, 'qwen-max');
  assert.deepEqual(config.capabilities, ['script-creator', 'wiki-reader']);
  assert.deepEqual(config.serverBinding, { petId: 'srv-001' });
});

test('parsePetLocalConfig rejects non-object input', () => {
  assert.throws(() => parsePet('not an object', 'src'), /not a JSON object/);
  assert.throws(() => parsePet(null, 'src'), /not a JSON object/);
});

test('parsePetLocalConfig requires petId and name', () => {
  assert.throws(() => parsePet({ name: 'X' }, 'src'), /missing required string "petId"/);
  assert.throws(() => parsePet({ petId: 'p1' }, 'src'), /missing required string "name"/);
});

test('parsePetLocalConfig rejects bad types in optional fields', () => {
  assert.throws(
    () => parsePet({ petId: 'p1', name: 'X', personality: '' }, 'src'),
    /"personality" must be a non-empty string/,
  );
  assert.throws(
    () => parsePet({ petId: 'p1', name: 'X', capabilities: 'not-an-array' }, 'src'),
    /"capabilities" must be a string\[\]/,
  );
  assert.throws(
    () => parsePet({ petId: 'p1', name: 'X', capabilities: ['ok', 123] }, 'src'),
    /"capabilities" must be a string\[\]/,
  );
});

test('parsePetLocalConfig rejects the retired raw model override', () => {
  assert.throws(
    () => parsePet(
      { petId: 'p1', name: 'X', model: 'qwen-max' },
      'src',
    ),
    /"model" was replaced by stable "modelProfileId"/,
  );
});

test('parsePetLocalConfig requires serverBinding.petId when serverBinding present', () => {
  assert.throws(
    () => parsePet({ petId: 'p1', name: 'X', serverBinding: {} }, 'src'),
    /\(serverBinding\): missing required string "petId"/,
  );
  assert.throws(
    () => parsePet({ petId: 'p1', name: 'X', serverBinding: 'string-not-object' }, 'src'),
    /"serverBinding" must be an object/,
  );
});


test('parseStudioLocalConfig accepts minimal valid config', () => {
  const cfg = parseStudio(
    { studioId: 's1', plannerPetId: 'p1', agents: ['p1'] },
    'test-source',
  );
  assert.equal(cfg.studioId, 's1');
  assert.equal(cfg.plannerPetId, 'p1');
  assert.deepEqual(cfg.agents, ['p1']);
});

test('parseStudioLocalConfig keeps optional fields when provided', () => {
  const cfg = parseStudio(
    {
      studioId: 's1',
      name: 'My Studio',
      description: 'desc',
      plannerPetId: 'p1',
      agents: ['p1', 'p2'],
      curator: { promptPath: './curator.md' },
      maxIterationCount: 16,
      maxRetryPerTask: 3,
    },
    'test-source',
  );
  assert.equal(cfg.name, 'My Studio');
  assert.equal(cfg.curator?.promptPath, './curator.md');
  assert.equal(cfg.maxIterationCount, 16);
  assert.equal(cfg.maxRetryPerTask, 3);
});

test('parseStudioLocalConfig rejects non-object input', () => {
  assert.throws(() => parseStudio(null, 'src'), /not a JSON object/);
});

test('parseStudioLocalConfig requires studioId / plannerPetId / agents', () => {
  assert.throws(
    () => parseStudio({ plannerPetId: 'p1', agents: ['p1'] }, 'src'),
    /missing required string "studioId"/,
  );
  assert.throws(
    () => parseStudio({ studioId: 's1', agents: ['p1'] }, 'src'),
    /missing required string "plannerPetId"/,
  );
  assert.throws(
    () => parseStudio({ studioId: 's1', plannerPetId: 'p1' }, 'src'),
    /"agents" must be a string\[\]/,
  );
  assert.throws(
    () => parseStudio({ studioId: 's1', plannerPetId: 'p1', agents: [] }, 'src'),
    /"agents" must not be empty/,
  );
});

test('parseStudioLocalConfig rejects bad guardrail values', () => {
  assert.throws(
    () => parseStudio(
      { studioId: 's1', plannerPetId: 'p1', agents: ['p1'], maxIterationCount: 0 },
      'src',
    ),
    /maxIterationCount.*positive integer/,
  );
  assert.throws(
    () => parseStudio(
      { studioId: 's1', plannerPetId: 'p1', agents: ['p1'], maxRetryPerTask: -1 },
      'src',
    ),
    /maxRetryPerTask.*positive integer/,
  );
});

test('parseStudioLocalConfig rejects bad curator shape', () => {
  assert.throws(
    () => parseStudio(
      { studioId: 's1', plannerPetId: 'p1', agents: ['p1'], curator: 'not-an-object' },
      'src',
    ),
    /"curator" must be an object/,
  );
  assert.throws(
    () => parseStudio(
      { studioId: 's1', plannerPetId: 'p1', agents: ['p1'], curator: { promptPath: '' } },
      'src',
    ),
    /\(curator\): "promptPath" must be a non-empty string/,
  );
});

test('resolveStudio joins pet configs in agents order', () => {
  const studio = parseStudio(
    { studioId: 's1', plannerPetId: 'p2', agents: ['p1', 'p2', 'p3'] },
    'src',
  );
  const pets = [pet('p3'), pet('p1'), pet('p2'), pet('orphan')];

  const resolved = resolveStudio(studio, pets);
  assert.deepEqual(resolved.agents.map((p) => p.petId), ['p1', 'p2', 'p3']);
  assert.equal(resolved.planner.petId, 'p2');
});

test('resolveStudio rejects duplicate agents', () => {
  const studio = parseStudio(
    { studioId: 's1', plannerPetId: 'p1', agents: ['p1', 'p1'] },
    'src',
  );
  assert.throws(
    () => resolveStudio(studio, [pet('p1')]),
    /agents array has duplicate petId "p1"/,
  );
});

test('resolveStudio rejects plannerPetId not in agents', () => {
  const studio = parseStudio(
    { studioId: 's1', plannerPetId: 'manager', agents: ['p1', 'p2'] },
    'src',
  );
  assert.throws(
    () => resolveStudio(studio, [pet('manager'), pet('p1'), pet('p2')]),
    /plannerPetId "manager" is not in agents/,
  );
});

test('resolveStudio rejects unknown agent reference', () => {
  const studio = parseStudio(
    { studioId: 's1', plannerPetId: 'p1', agents: ['p1', 'ghost'] },
    'src',
  );
  assert.throws(
    () => resolveStudio(studio, [pet('p1')]),
    /agent "ghost" has no matching pet config/,
  );
});
