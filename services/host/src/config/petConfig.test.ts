import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfigValue } from '@pinpawo/pet-agent';

import {
  loadPetDocument,
  loadPetConfigs,
  petConfigSchema,
  resolvePetCapabilityDirectory,
  resolveSharedCapabilityDirectory,
  resolvePetDocumentPath,
} from './petConfig';

// File entry conventions plus shared-reference configuration at the Host boundary.

async function mkTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeJson(dir: string, file: string, value: unknown): Promise<void> {
  await fs.writeFile(path.join(dir, file), JSON.stringify(value), 'utf8');
}

test('loadPetConfigs returns [] when directory does not exist', async () => {
  const result = await loadPetConfigs(path.join(os.tmpdir(), 'nonexistent-dir-xyz-' + Date.now()));
  assert.deepEqual(result, []);
});

test('loadPetConfigs returns [] for an empty directory', async () => {
  const dir = await mkTempDir('pet-cfg-empty-');
  const result = await loadPetConfigs(dir);
  assert.deepEqual(result, []);
});

test('loadPetConfigs loads all *.json files in sorted order', async () => {
  const dir = await mkTempDir('pet-cfg-multi-');
  await writeJson(dir, 'b.json', { definitionId: 'b', name: 'B' });
  await writeJson(dir, 'a.json', { definitionId: 'a', name: 'A' });
  await writeJson(dir, 'c.json', { definitionId: 'c', name: 'C' });
  // 非 json 文件应被忽略
  await fs.writeFile(path.join(dir, 'notes.md'), 'hello', 'utf8');

  const result = await loadPetConfigs(dir);
  assert.deepEqual(result.map((p) => p.definitionId), ['a', 'b', 'c']);
});

test('loadPetConfigs rejects duplicate definition ids across files', async () => {
  const dir = await mkTempDir('pet-cfg-dup-');
  await writeJson(dir, 'first.json', { definitionId: 'shared', name: 'First' });
  await writeJson(dir, 'second.json', { definitionId: 'shared', name: 'Second' });

  await assert.rejects(
    () => loadPetConfigs(dir),
    /duplicate pet definitionId "shared"/,
  );
});

test('loadPetConfigs surfaces invalid JSON with file path', async () => {
  const dir = await mkTempDir('pet-cfg-badjson-');
  await fs.writeFile(path.join(dir, 'broken.json'), '{not-json}', 'utf8');

  await assert.rejects(
    () => loadPetConfigs(dir),
    /broken\.json is not valid JSON/,
  );
});

test('loadPetConfigs surfaces schema errors with file path', async () => {
  const dir = await mkTempDir('pet-cfg-badschema-');
  await writeJson(dir, 'no-name.json', { definitionId: 'p1' });

  await assert.rejects(
    () => loadPetConfigs(dir),
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

test('shared Capability configuration selects unique names without treating them as paths', () => {
  const base = { definitionId: 'worker', name: 'Worker' };
  assert.deepEqual(parseConfigValue({ ...base, sharedCapabilities: [' channel_context ', 'lookup-v2'] }, petConfigSchema, 'pet.json').sharedCapabilities,
    ['channel_context', 'lookup-v2']);
  assert.deepEqual(parseConfigValue({ ...base, sharedCapabilities: [] }, petConfigSchema, 'pet.json').sharedCapabilities, []);
  assert.equal(parseConfigValue(base, petConfigSchema, 'pet.json').sharedCapabilities, undefined);
  for (const sharedCapabilities of [null, 'channel_context', [1], [''], [' '], ['../escape'], ['UpperCase'], ['a/b'], ['context', ' context ']]) {
    assert.throws(() => parseConfigValue({ ...base, sharedCapabilities }, petConfigSchema, 'pet.json'), /sharedCapabilities/);
  }
  assert.equal(resolveSharedCapabilityDirectory('/workspace/.pinpawo/pets'), path.resolve('/workspace/.pinpawo/capabilities'));
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
