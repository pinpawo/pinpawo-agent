import { petConfigSchema, type PetConfig } from 'pinpawo/host-runtime';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigValue } from '@pinpawo/pet-agent';

import {
  resolveStudio,
  studioLocalConfigSchema,
  type StudioLocalConfig,
} from './configSchema';

// schema 只负责结构;文件入口由宿主提供，因此这里直接喂已解析的值。
const parsePet = (raw: unknown, source: string): PetConfig =>
  parseConfigValue(raw, petConfigSchema, source);
const parseStudio = (raw: unknown, source: string): StudioLocalConfig =>
  parseConfigValue(raw, studioLocalConfigSchema, source);

function pet(definitionId: string, overrides: Partial<PetConfig> = {}): PetConfig {
  return {
    definitionId,
    name: `Pet ${definitionId}`,
    ...overrides,
  };
}

test('parsePetLocalConfig accepts minimal valid config', () => {
  const config = parsePet(
    { definitionId: 'p1', name: 'Pet 1' },
    'test-source',
  );
  assert.equal(config.definitionId, 'p1');
  assert.equal(config.name, 'Pet 1');
});

test('parsePetLocalConfig keeps optional fields when provided', () => {
  const config = parsePet(
    {
      definitionId: 'p1',
      name: 'Script Pet',
      modelProfileId: 'qwen-max',
      defaultCapabilityName: 'studio_planning',
    },
    'test-source',
  );
  assert.equal(config.modelProfileId, 'qwen-max');
  assert.equal(config.defaultCapabilityName, 'studio_planning');
});

test('parsePetLocalConfig rejects non-object input', () => {
  assert.throws(() => parsePet('not an object', 'src'), /not a JSON object/);
  assert.throws(() => parsePet(null, 'src'), /not a JSON object/);
});

test('parsePetLocalConfig requires definitionId and name', () => {
  assert.throws(() => parsePet({ name: 'X' }, 'src'), /missing required string "definitionId"/);
  assert.throws(() => parsePet({ definitionId: 'p1' }, 'src'), /missing required string "name"/);
});

test('parsePetLocalConfig rejects bad types in optional fields', () => {
  assert.throws(
    () => parsePet({ definitionId: 'p1', name: 'X', modelProfileId: '' }, 'src'),
    /"modelProfileId" must be a non-empty string/,
  );
});

test('parsePetLocalConfig rejects retired capability name lists', () => {
  assert.throws(
    () => parsePet({ definitionId: 'p1', name: 'X', capabilities: ['inspect'] }, 'src'),
    /"capabilities" was replaced by the conventional pets\/<definitionId>\/capabilities directory/,
  );
});

test('parsePetLocalConfig requires definitionId to be a safe directory segment', () => {
  for (const definitionId of [
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
      () => parsePet({ definitionId, name: 'X' }, 'src'),
      /"definitionId" must be a safe path segment/,
    );
  }
});

test('parsePetLocalConfig rejects the old petId field with migration guidance', () => {
  assert.throws(
    () => parsePet({ petId: 'p1', definitionId: 'p1', name: 'X' }, 'src'),
    /"petId" was renamed to "definitionId"/,
  );
});

test('parsePetLocalConfig rejects the retired raw model override', () => {
  assert.throws(
    () => parsePet(
      { definitionId: 'p1', name: 'X', model: 'qwen-max' },
      'src',
    ),
    /"model" was replaced by stable "modelProfileId"/,
  );
});

test('retired cloud bindings and persona fields fail with migration guidance', () => {
  for (const field of ['personality', 'species', 'stage']) {
    assert.throws(() => parsePet({ definitionId: 'p1', name: 'X', [field]: 'old' }, 'src'), /PET\.md/);
  }
  for (const serverBinding of [{ cloud: true }, {}, null, 'old']) {
    assert.throws(() => parsePet({ definitionId: 'p1', name: 'X', serverBinding }, 'src'), /serverBinding.*no longer supported/);
  }
});

test('parseStudioLocalConfig accepts minimal valid config', () => {
  const cfg = parseStudio(
    { studioId: 's1', definitions: ['p1'] },
    'test-source',
  );
  assert.equal(cfg.studioId, 's1');
  assert.deepEqual(cfg.definitions, ['p1']);
  assert.equal(cfg.plugins, undefined);
});

test('parseStudioLocalConfig keeps optional fields when provided', () => {
  const cfg = parseStudio(
    {
      studioId: 's1',
      name: 'My Studio',
      description: 'desc',
      definitions: ['p1', 'p2'],
    },
    'test-source',
  );
  assert.equal(cfg.name, 'My Studio');
  assert.equal(cfg.description, 'desc');
});

test('parseStudioLocalConfig rejects non-object input', () => {
  assert.throws(() => parseStudio(null, 'src'), /not a JSON object/);
});

test('parseStudioLocalConfig requires studioId / definitions', () => {
  assert.throws(
    () => parseStudio({ definitions: ['p1'] }, 'src'),
    /missing required string "studioId"/,
  );
  assert.throws(
    () => parseStudio({ studioId: 's1' }, 'src'),
    /"definitions" must be a string\[\]/,
  );
  assert.throws(
    () => parseStudio({ studioId: 's1', definitions: [] }, 'src'),
    /"definitions" must not be empty/,
  );
});

test('parseStudioLocalConfig rejects the retired pets and entryPetId fields', () => {
  assert.throws(
    () => parseStudio({ studioId: 's1', pets: ['p1'] }, 'src'),
    /"pets" was renamed to "definitions"/,
  );
  assert.throws(
    () => parseStudio({ studioId: 's1', definitions: ['p1'], entryPetId: 'p1' }, 'src'),
    /"entryPetId" was removed/,
  );
});

test('parseStudioLocalConfig passes plugin options through without interpreting them', () => {
  // studio 不认识任何插件的领域概念 —— options 原样透传,校验归插件自己。
  const cfg = parseStudio(
    {
      studioId: 's1',
      definitions: ['p1'],
      plugins: [
        { id: 'example-work' },
        { id: 'scheduler', options: { timezone: 'Asia/Shanghai', nested: { any: 1 } } },
      ],
    },
    'src',
  );

  assert.deepEqual(cfg.plugins?.map((plugin) => plugin.id), ['example-work', 'scheduler']);
  assert.equal(cfg.plugins?.[0]?.options, undefined);
  assert.deepEqual(cfg.plugins?.[1]?.options, {
    timezone: 'Asia/Shanghai',
    nested: { any: 1 },
  });
});

test('parseStudioLocalConfig rejects malformed plugin entries', () => {
  const base = { studioId: 's1', definitions: ['p1'] };
  assert.throws(
    () => parseStudio({ ...base, plugins: 'example-work' }, 'src'),
    /"plugins" must be an array when present/,
  );
  assert.throws(
    () => parseStudio({ ...base, plugins: ['example-work'] }, 'src'),
    /"plugins\[0\]" must be an object/,
  );
  assert.throws(
    () => parseStudio({ ...base, plugins: [{ options: {} }] }, 'src'),
    /"plugins\[0\]\.id" must be a non-empty string/,
  );
  assert.throws(
    () => parseStudio({ ...base, plugins: [{ id: 'example-work', options: [] }] }, 'src'),
    /"plugins\[0\]\.options" must be an object when present/,
  );
});

test('parseStudioLocalConfig allows multiple instances of one Plugin id', () => {
  const cfg = parseStudio({
    studioId: 's1',
    definitions: ['p1'],
    plugins: [
      { id: 'scheduler', options: { instance: 'morning' } },
      { id: 'scheduler', options: { instance: 'evening' } },
    ],
  }, 'src');

  assert.deepEqual(cfg.plugins?.map(({ id }) => id), ['scheduler', 'scheduler']);
});

test('resolveStudio joins Pet definitions in definitions order', () => {
  const studio = parseStudio(
    { studioId: 's1', definitions: ['p1', 'p2', 'p3'] },
    'src',
  );
  const petConfigs = [pet('p3'), pet('p1'), pet('p2'), pet('orphan')];

  const resolved = resolveStudio(studio, petConfigs);
  assert.deepEqual(resolved.definitions.map((p) => p.definitionId), ['p1', 'p2', 'p3']);
});

test('resolveStudio rejects duplicate definitions', () => {
  const studio = parseStudio(
    { studioId: 's1', definitions: ['p1', 'p1'] },
    'src',
  );
  assert.throws(
    () => resolveStudio(studio, [pet('p1')]),
    /definitions array has duplicate id "p1"/,
  );
});

test('resolveStudio rejects unknown definition reference', () => {
  const studio = parseStudio(
    { studioId: 's1', definitions: ['p1', 'ghost'] },
    'src',
  );
  assert.throws(
    () => resolveStudio(studio, [pet('p1')]),
    /definition "ghost" has no matching file/,
  );
});
