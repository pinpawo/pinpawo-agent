import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { validateCapabilityPlugin } from '../capabilityLoader';
import { buildConfigGuideReport } from './config';
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

test('buildConfigGuideReport detects missing, defaulted, and placeholder config', () => {
  const targetDir = mkdtempSync(resolve(tmpdir(), 'pinpawo-config-'));
  scaffoldQuickInstall({ dir: targetDir, exampleCapability: false });

  const report = buildConfigGuideReport({ dir: targetDir }, { stored: {} });
  const byKey = Object.fromEntries(report.items.map((item) => [item.key, item]));

  assert.equal(byKey.LLM_API_KEY?.status, 'placeholder');
  assert.equal(byKey.LLM_BASE_URL?.status, 'ok');
  assert.equal(byKey.LLM_MODEL?.status, 'ok');
  assert.equal(byKey.PINPAWO_WORKDIR?.status, 'ok');
  assert.equal(byKey.API_BASE_URL?.status, 'placeholder');
  assert.equal(byKey.HASURA_ENDPOINT?.status, 'placeholder');
  assert.equal(byKey.AGENT_TOKEN?.status, 'placeholder');
  assert.equal(byKey.HASURA_JWT?.status, 'placeholder');
});

test('buildConfigGuideReport accepts stored LLM config when env file is absent', () => {
  const targetDir = mkdtempSync(resolve(tmpdir(), 'pinpawo-config-'));
  const report = buildConfigGuideReport({ dir: targetDir }, {
    env: {},
    stored: {
      llm_api_key: 'stored-key',
      llm_base_url: 'https://llm.example.com',
      llm_model: 'model-a',
    },
  });
  const byKey = Object.fromEntries(report.items.map((item) => [item.key, item]));

  assert.equal(byKey.LLM_API_KEY?.status, 'ok');
  assert.equal(byKey.LLM_API_KEY?.source, 'stored');
  assert.equal(byKey.LLM_BASE_URL?.source, 'stored');
  assert.equal(byKey.LLM_MODEL?.source, 'stored');
});
