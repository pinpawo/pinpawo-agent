import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadStudioLocalConfig } from './studioConfig';

// 本文件只覆盖**文件入口**。schema、字段校验与 resolveStudio 的测试
// 在上层 configSchema.test.ts。

async function mkTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('loadStudioLocalConfig returns null when file does not exist', async () => {
  const result = await loadStudioLocalConfig(path.join(os.tmpdir(), 'nonexistent-' + Date.now() + '.json'));
  assert.equal(result, null);
});

test('loadStudioLocalConfig reads and parses a valid file', async () => {
  const dir = await mkTempDir('studio-cfg-');
  const filePath = path.join(dir, 'studio.json');
  await fs.writeFile(filePath, JSON.stringify({
    studioId: 's1',
    entryPetId: 'p1',
    pets: ['p1', 'p2'],
  }), 'utf8');

  const cfg = await loadStudioLocalConfig(filePath);
  assert.equal(cfg?.studioId, 's1');
  assert.deepEqual(cfg?.pets, ['p1', 'p2']);
});

test('loadStudioLocalConfig surfaces invalid JSON', async () => {
  const dir = await mkTempDir('studio-cfg-badjson-');
  const filePath = path.join(dir, 'studio.json');
  await fs.writeFile(filePath, '{broken', 'utf8');

  await assert.rejects(
    () => loadStudioLocalConfig(filePath),
    /not valid JSON/,
  );
});
