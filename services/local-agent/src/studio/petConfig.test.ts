import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadPetLocalConfigs, parsePetLocalConfig } from './petConfig';

async function mkTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeJson(dir: string, name: string, body: unknown): Promise<string> {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, JSON.stringify(body), 'utf8');
  return filePath;
}

test('parsePetLocalConfig accepts minimal valid config', () => {
  const config = parsePetLocalConfig(
    { petId: 'p1', name: 'Pet 1' },
    'test-source',
  );
  assert.equal(config.petId, 'p1');
  assert.equal(config.name, 'Pet 1');
  assert.deepEqual(config.capabilities, []);
  assert.equal(config.serverBinding, undefined);
});

test('parsePetLocalConfig keeps optional fields when provided', () => {
  const config = parsePetLocalConfig(
    {
      petId: 'p1',
      name: 'Script Pet',
      personality: '创意丰富',
      role: '脚本撰写',
      serviceSummary: '短视频脚本',
      model: 'qwen-max',
      capabilities: ['script-creator', 'wiki-reader'],
      serverBinding: { petId: 'srv-001' },
    },
    'test-source',
  );
  assert.equal(config.personality, '创意丰富');
  assert.equal(config.model, 'qwen-max');
  assert.deepEqual(config.capabilities, ['script-creator', 'wiki-reader']);
  assert.deepEqual(config.serverBinding, { petId: 'srv-001' });
});

test('parsePetLocalConfig rejects non-object input', () => {
  assert.throws(() => parsePetLocalConfig('not an object', 'src'), /not a JSON object/);
  assert.throws(() => parsePetLocalConfig(null, 'src'), /not a JSON object/);
});

test('parsePetLocalConfig requires petId and name', () => {
  assert.throws(() => parsePetLocalConfig({ name: 'X' }, 'src'), /missing required string "petId"/);
  assert.throws(() => parsePetLocalConfig({ petId: 'p1' }, 'src'), /missing required string "name"/);
});

test('parsePetLocalConfig rejects bad types in optional fields', () => {
  assert.throws(
    () => parsePetLocalConfig({ petId: 'p1', name: 'X', personality: '' }, 'src'),
    /"personality" must be a non-empty string/,
  );
  assert.throws(
    () => parsePetLocalConfig({ petId: 'p1', name: 'X', capabilities: 'not-an-array' }, 'src'),
    /"capabilities" must be a string\[\]/,
  );
  assert.throws(
    () => parsePetLocalConfig({ petId: 'p1', name: 'X', capabilities: ['ok', 123] }, 'src'),
    /"capabilities" must be a string\[\]/,
  );
});

test('parsePetLocalConfig requires serverBinding.petId when serverBinding present', () => {
  assert.throws(
    () => parsePetLocalConfig({ petId: 'p1', name: 'X', serverBinding: {} }, 'src'),
    /"serverBinding\.petId" must be a non-empty string/,
  );
  assert.throws(
    () => parsePetLocalConfig({ petId: 'p1', name: 'X', serverBinding: 'string-not-object' }, 'src'),
    /"serverBinding" must be an object/,
  );
});

test('loadPetLocalConfigs returns [] when directory does not exist', async () => {
  const result = await loadPetLocalConfigs(path.join(os.tmpdir(), 'nonexistent-dir-xyz-' + Date.now()));
  assert.deepEqual(result, []);
});

test('loadPetLocalConfigs returns [] for an empty directory', async () => {
  const dir = await mkTempDir('pet-cfg-empty-');
  const result = await loadPetLocalConfigs(dir);
  assert.deepEqual(result, []);
});

test('loadPetLocalConfigs loads all *.json files in sorted order', async () => {
  const dir = await mkTempDir('pet-cfg-multi-');
  await writeJson(dir, 'b.json', { petId: 'b', name: 'B' });
  await writeJson(dir, 'a.json', { petId: 'a', name: 'A' });
  await writeJson(dir, 'c.json', { petId: 'c', name: 'C' });
  // 非 json 文件应被忽略
  await fs.writeFile(path.join(dir, 'notes.md'), 'hello', 'utf8');

  const result = await loadPetLocalConfigs(dir);
  assert.deepEqual(result.map((p) => p.petId), ['a', 'b', 'c']);
});

test('loadPetLocalConfigs rejects duplicate petIds across files', async () => {
  const dir = await mkTempDir('pet-cfg-dup-');
  await writeJson(dir, 'first.json', { petId: 'shared', name: 'First' });
  await writeJson(dir, 'second.json', { petId: 'shared', name: 'Second' });

  await assert.rejects(
    () => loadPetLocalConfigs(dir),
    /duplicate pet config petId "shared"/,
  );
});

test('loadPetLocalConfigs surfaces invalid JSON with file path', async () => {
  const dir = await mkTempDir('pet-cfg-badjson-');
  await fs.writeFile(path.join(dir, 'broken.json'), '{not-json}', 'utf8');

  await assert.rejects(
    () => loadPetLocalConfigs(dir),
    /broken\.json is not valid JSON/,
  );
});

test('loadPetLocalConfigs surfaces schema errors with file path', async () => {
  const dir = await mkTempDir('pet-cfg-badschema-');
  await writeJson(dir, 'no-name.json', { petId: 'p1' });

  await assert.rejects(
    () => loadPetLocalConfigs(dir),
    /no-name\.json: missing required string "name"/,
  );
});
