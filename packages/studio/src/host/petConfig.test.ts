import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadPetDocument,
  loadPetLocalConfigs,
  resolvePetCapabilityDirectory,
  resolvePetDocumentPath,
} from './petConfig';

// 本文件只覆盖**文件入口**:去哪读、读哪些、目录级一致性。
// schema 与字段校验的测试在上层 configSchema.test.ts。

async function mkTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeJson(dir: string, file: string, value: unknown): Promise<void> {
  await fs.writeFile(path.join(dir, file), JSON.stringify(value), 'utf8');
}

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

test('resolvePetCapabilityDirectory derives the conventional per-Pet root', () => {
  assert.equal(
    resolvePetCapabilityDirectory('/workspace/.pinpawo/pets', 'planner'),
    path.resolve('/workspace/.pinpawo/pets/planner/capabilities'),
  );
  assert.throws(
    () => resolvePetCapabilityDirectory('/workspace/.pinpawo/pets', '../escape'),
    /safe path segment/,
  );
  assert.throws(
    () => resolvePetCapabilityDirectory('/workspace/.pinpawo/pets', 'D:'),
    /safe path segment/,
  );
  assert.throws(
    () => resolvePetCapabilityDirectory('/workspace/.pinpawo/pets', ''),
    /safe path segment/,
  );
});

test('loadPetDocument reads the conventional optional PET.md document', async () => {
  const dir = await mkTempDir('pet-document-');
  await fs.mkdir(path.join(dir, 'executor'), { recursive: true });
  await fs.writeFile(path.join(dir, 'executor', 'PET.md'), '# Executor\n\nUse one worktree.\n');

  const loaded = await loadPetDocument(dir, 'executor');
  assert.equal(loaded?.content, '# Executor\n\nUse one worktree.');
  assert.equal(loaded?.digest.length, 64);
  assert.equal(
    resolvePetDocumentPath(dir, 'executor'),
    path.join(dir, 'executor', 'PET.md'),
  );
  assert.equal(await loadPetDocument(dir, 'planner'), null);
});
