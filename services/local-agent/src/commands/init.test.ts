import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { validateCapabilityPlugin } from '../capabilityLoader';
import { buildModelProfileRegistry, resolveModelProfile } from '../modelProfiles';
import { scaffoldQuickInstall } from './init';

test('scaffoldQuickInstall creates a stored model profile, env template, and valid example capability', async () => {
  const targetDir = mkdtempSync(resolve(tmpdir(), 'pinpawo-init-'));

  const result = scaffoldQuickInstall({ dir: targetDir });

  assert.equal(result.rootDir, targetDir);
  assert.equal(result.capabilitiesDir, resolve(targetDir, 'capabilities'));
  assert.deepEqual(
    result.written.map((file) => file.status),
    ['created', 'created', 'created'],
  );
  assert.match(readFileSync(resolve(targetDir, '.env'), 'utf-8'), /Model profiles.*config\.json/);
  const stored = JSON.parse(readFileSync(resolve(targetDir, 'config.json'), 'utf-8'));
  assert.equal(resolveModelProfile(buildModelProfileRegistry({ stored, env: {} })).id, 'primary');

  const validation = await validateCapabilityPlugin(resolve(targetDir, 'capabilities', 'hello-pinpawo'));
  assert.equal(validation.ok, true, validation.errors.join('; '));
  assert.equal(validation.meta?.id, 'hello-pinpawo');
});

test('scaffoldQuickInstall migrates a complete legacy environment model tuple into config.json', () => {
  const targetDir = mkdtempSync(resolve(tmpdir(), 'pinpawo-init-'));
  writeFileSync(resolve(targetDir, '.env'), [
    'LLM_API_KEY=legacy-secret',
    'LLM_BASE_URL=https://models.example.test/v1',
    'LLM_MODEL=legacy-model',
    'LLM_CONTEXT_WINDOW_TOKENS=128000',
  ].join('\n'));

  scaffoldQuickInstall({ dir: targetDir, exampleCapability: false });

  const stored = JSON.parse(readFileSync(resolve(targetDir, 'config.json'), 'utf-8'));
  const profile = resolveModelProfile(buildModelProfileRegistry({ stored, env: {} }));
  assert.equal(profile.apiKey, 'legacy-secret');
  assert.equal(profile.baseUrl, 'https://models.example.test/v1');
  assert.equal(profile.model, 'legacy-model');
  assert.equal(profile.contextWindowTokens, 128000);
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
