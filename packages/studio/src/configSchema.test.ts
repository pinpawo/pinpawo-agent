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
      serverBinding: { petId: 'srv-001' },
    },
    'test-source',
  );
  assert.equal(config.personality, '创意丰富');
  assert.equal(config.modelProfileId, 'qwen-max');
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
});

test('parsePetLocalConfig rejects retired capability name lists', () => {
  assert.throws(
    () => parsePet({ petId: 'p1', name: 'X', capabilities: ['inspect'] }, 'src'),
    /"capabilities" was replaced by the conventional pets\/<petId>\/capabilities directory/,
  );
});

test('parsePetLocalConfig requires petId to be a safe directory segment', () => {
  for (const petId of [
    '.',
    '..',
    '../escape',
    'nested/pet',
    'nested\\pet',
    'D:',
    'a:b',
    'CON',
    'com1.txt',
    'trailing.',
    'trailing ',
  ]) {
    assert.throws(
      () => parsePet({ petId, name: 'X' }, 'src'),
      /"petId" must be a safe path segment/,
    );
  }
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
    { studioId: 's1', entryPetId: 'p1', pets: ['p1'] },
    'test-source',
  );
  assert.equal(cfg.studioId, 's1');
  assert.equal(cfg.entryPetId, 'p1');
  assert.deepEqual(cfg.pets, ['p1']);
  assert.equal(cfg.plugins, undefined);
});

test('parseStudioLocalConfig keeps optional fields when provided', () => {
  const cfg = parseStudio(
    {
      studioId: 's1',
      name: 'My Studio',
      description: 'desc',
      entryPetId: 'p1',
      pets: ['p1', 'p2'],
    },
    'test-source',
  );
  assert.equal(cfg.name, 'My Studio');
  assert.equal(cfg.description, 'desc');
});

test('parseStudioLocalConfig rejects non-object input', () => {
  assert.throws(() => parseStudio(null, 'src'), /not a JSON object/);
});

test('parseStudioLocalConfig requires studioId / entryPetId / pets', () => {
  assert.throws(
    () => parseStudio({ entryPetId: 'p1', pets: ['p1'] }, 'src'),
    /missing required string "studioId"/,
  );
  assert.throws(
    () => parseStudio({ studioId: 's1', pets: ['p1'] }, 'src'),
    /missing required string "entryPetId"/,
  );
  assert.throws(
    () => parseStudio({ studioId: 's1', entryPetId: 'p1' }, 'src'),
    /"pets" must be a string\[\]/,
  );
  assert.throws(
    () => parseStudio({ studioId: 's1', entryPetId: 'p1', pets: [] }, 'src'),
    /"pets" must not be empty/,
  );
});

test('parseStudioLocalConfig passes plugin options through without interpreting them', () => {
  // studio 不认识任何插件的领域概念 —— options 原样透传,校验归插件自己。
  const cfg = parseStudio(
    {
      studioId: 's1',
      entryPetId: 'p1',
      pets: ['p1'],
      plugins: [
        { id: 'kanban' },
        { id: 'scheduler', options: { timezone: 'Asia/Shanghai', nested: { any: 1 } } },
      ],
    },
    'src',
  );

  assert.deepEqual(cfg.plugins?.map((plugin) => plugin.id), ['kanban', 'scheduler']);
  assert.equal(cfg.plugins?.[0]?.options, undefined);
  assert.deepEqual(cfg.plugins?.[1]?.options, {
    timezone: 'Asia/Shanghai',
    nested: { any: 1 },
  });
});

test('parseStudioLocalConfig rejects malformed plugin entries', () => {
  const base = { studioId: 's1', entryPetId: 'p1', pets: ['p1'] };
  assert.throws(
    () => parseStudio({ ...base, plugins: 'kanban' }, 'src'),
    /"plugins" must be an array when present/,
  );
  assert.throws(
    () => parseStudio({ ...base, plugins: ['kanban'] }, 'src'),
    /"plugins\[0\]" must be an object/,
  );
  assert.throws(
    () => parseStudio({ ...base, plugins: [{ options: {} }] }, 'src'),
    /"plugins\[0\]\.id" must be a non-empty string/,
  );
  assert.throws(
    () => parseStudio({ ...base, plugins: [{ id: 'kanban', options: [] }] }, 'src'),
    /"plugins\[0\]\.options" must be an object when present/,
  );
});

test('parseStudioLocalConfig allows multiple instances of one Plugin id', () => {
  const cfg = parseStudio({
    studioId: 's1',
    entryPetId: 'p1',
    pets: ['p1'],
    plugins: [
      { id: 'scheduler', options: { instance: 'morning' } },
      { id: 'scheduler', options: { instance: 'evening' } },
    ],
  }, 'src');

  assert.deepEqual(cfg.plugins?.map(({ id }) => id), ['scheduler', 'scheduler']);
});

test('resolveStudio joins pet configs in pets order', () => {
  const studio = parseStudio(
    { studioId: 's1', entryPetId: 'p2', pets: ['p1', 'p2', 'p3'] },
    'src',
  );
  const petConfigs = [pet('p3'), pet('p1'), pet('p2'), pet('orphan')];

  const resolved = resolveStudio(studio, petConfigs);
  assert.deepEqual(resolved.pets.map((p) => p.petId), ['p1', 'p2', 'p3']);
  assert.equal(resolved.entryPet.petId, 'p2');
});

test('resolveStudio rejects duplicate pets', () => {
  const studio = parseStudio(
    { studioId: 's1', entryPetId: 'p1', pets: ['p1', 'p1'] },
    'src',
  );
  assert.throws(
    () => resolveStudio(studio, [pet('p1')]),
    /pets array has duplicate petId "p1"/,
  );
});

test('resolveStudio rejects entryPetId not in pets', () => {
  const studio = parseStudio(
    { studioId: 's1', entryPetId: 'manager', pets: ['p1', 'p2'] },
    'src',
  );
  assert.throws(
    () => resolveStudio(studio, [pet('manager'), pet('p1'), pet('p2')]),
    /entryPetId "manager" is not in pets/,
  );
});

test('resolveStudio rejects unknown pet reference', () => {
  const studio = parseStudio(
    { studioId: 's1', entryPetId: 'p1', pets: ['p1', 'ghost'] },
    'src',
  );
  assert.throws(
    () => resolveStudio(studio, [pet('p1')]),
    /pet "ghost" has no matching pet config/,
  );
});
