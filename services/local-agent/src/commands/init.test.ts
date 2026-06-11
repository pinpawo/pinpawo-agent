import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { validateCapabilityPlugin } from '../capabilityLoader';
import { scaffoldQuickInstall } from './init';

test('scaffoldQuickInstall creates env template and a valid example capability', async () => {
  const targetDir = mkdtempSync(resolve(tmpdir(), 'pinpawo-init-'));

  const result = scaffoldQuickInstall({ dir: targetDir });

  assert.equal(result.rootDir, targetDir);
  assert.equal(result.capabilitiesDir, resolve(targetDir, 'capabilities'));
  assert.deepEqual(
    result.written.map((file) => file.status),
    ['created', 'created', 'created'],
  );
  assert.match(readFileSync(resolve(targetDir, '.env'), 'utf-8'), /LLM_API_KEY=sk-xxx/);

  const validation = await validateCapabilityPlugin(resolve(targetDir, 'capabilities', 'hello-pinpawo'));
  assert.equal(validation.ok, true, validation.errors.join('; '));
  assert.equal(validation.meta?.id, 'hello-pinpawo');
});

test('scaffoldQuickInstall skips existing generated files unless forced', () => {
  const targetDir = mkdtempSync(resolve(tmpdir(), 'pinpawo-init-'));

  scaffoldQuickInstall({ dir: targetDir });
  const result = scaffoldQuickInstall({ dir: targetDir });

  assert.deepEqual(
    result.written.map((file) => file.status),
    ['skipped', 'skipped', 'skipped'],
  );
});
