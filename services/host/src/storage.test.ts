import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// CONFIG_PATH is fixed when storage loads, so point HOME at a temp dir first.
const home = await mkdtemp(path.join(os.tmpdir(), 'pinpawo-storage-'));
process.env.HOME = home;
const { loadStoredConfig, saveStoredConfig, configPath } = await import('./storage');
const file = path.join(home, '.pinpawo', 'config.json');

test('stored config starts empty when the file is missing and saves a first config', async () => {
  assert.equal(configPath(), file);
  assert.deepEqual(loadStoredConfig(), {});
  saveStoredConfig({ workdir: '/work' });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { workdir: '/work' });
  saveStoredConfig({ ...loadStoredConfig(), global_review_policy: 'auto' });
  assert.deepEqual(loadStoredConfig(), { workdir: '/work', global_review_policy: 'auto' });
});

test('stored config that is not a JSON object reads as empty and is never saved over', async () => {
  await mkdir(path.dirname(file), { recursive: true });
  for (const content of ['{"workdir": "/work",', 'null', '[1]', '"text"']) {
    await writeFile(file, content, 'utf8');
    assert.deepEqual(loadStoredConfig(), {});
    assert.throws(() => saveStoredConfig({ global_review_policy: 'auto' }), /Refusing to overwrite/);
    assert.equal(await readFile(file, 'utf8'), content);
  }
});

test('stored config that cannot be read is never saved over', { skip: process.getuid?.() === 0 }, async () => {
  await writeFile(file, JSON.stringify({ workdir: '/work' }), 'utf8');
  await chmod(file, 0o000);
  try {
    assert.deepEqual(loadStoredConfig(), {});
    assert.throws(() => saveStoredConfig({ global_review_policy: 'auto' }), /cannot be read \(EACCES\)/);
  } finally {
    await chmod(file, 0o600);
  }
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { workdir: '/work' });
});
