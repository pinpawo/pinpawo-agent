import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildSetupGuide,
  formatSetupGuide,
} from './configDiagnostics';
import type { LocalAgentRuntimeConfig } from './runtimeConfig';

test('buildSetupGuide reports missing required and recommended config', () => {
  const runtimeConfig = runtimeConfigForMissingStudio();
  const guide = buildSetupGuide({
    stored: {},
    env: {},
    configFilePath: '/tmp/pinpawo/config.json',
    runtimeConfig,
  });

  assert.equal(guide.readyForLocalRun, false);
  assert.deepEqual(
    guide.checks.map((check) => [check.id, check.status]),
    [
      ['llm', 'missing'],
      ['studio-config', 'warning'],
    ],
  );
  assert.match(formatSetupGuide(guide), /models.defaultProfileId/);
  assert.match(formatSetupGuide(guide), new RegExp(escapeRegExp(runtimeConfig.workdir)));
  const studioCheck = guide.checks.find((check) => check.id === 'studio-config');
  assert.equal(studioCheck?.nextStep, `Create ${runtimeConfig.studioConfigPath}.`);
  assert.match(studioCheck?.detail ?? '', /independent Studio Host/);
  assert.doesNotMatch(studioCheck?.detail ?? '', /Studio mode/);
  assert.doesNotMatch(formatSetupGuide(guide), /studio migrate/);
});

test('a runnable model profile is all local startup needs', () => {
  // 托管 API 与 actor 选择随 app relay 一并移除:能跑起模型就算就绪。
  const guide = buildSetupGuide({
    stored: { llm_api_key: 'llm-key' },
    env: {},
    configFilePath: '/tmp/pinpawo/config.json',
    runtimeConfig: runtimeConfigForMissingStudio(),
  });

  assert.equal(guide.readyForLocalRun, true);
  assert.equal(guide.checks.find((check) => check.id === 'llm')?.status, 'ok');
  assert.equal(guide.checks.some((check) => check.id === 'hosted-api'), false);
  assert.equal(guide.checks.some((check) => check.id === 'actor'), false);
});

test('buildSetupGuide reports workdir-scoped Studio config when present', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinpawo-setup-'));
  const runtimeConfig = runtimeConfigFor(root);
  await fs.mkdir(runtimeConfig.stateRoot, { recursive: true });
  await fs.writeFile(runtimeConfig.studioConfigPath, '{}', 'utf8');

  const guide = buildSetupGuide({
    stored: { llm_api_key: 'llm-key' },
    env: {},
    runtimeConfig,
  });

  assert.equal(guide.workdir, root);
  assert.equal(guide.stateRoot, runtimeConfig.stateRoot);
  assert.equal(guide.checks.find((check) => check.id === 'studio-config')?.status, 'ok');
});


function runtimeConfigForMissingStudio(): LocalAgentRuntimeConfig {
  return runtimeConfigFor(join(tmpdir(), `pinpawo-missing-${randomUUID()}`));
}

function runtimeConfigFor(workdir: string): LocalAgentRuntimeConfig {
  const stateRoot = join(workdir, '.pinpawo');
  return {
    workdir,
    stateRoot,
    studioConfigPath: join(stateRoot, 'studio.json'),
    studioDueRunsPath: join(stateRoot, 'studio-due-runs.json'),
    petsDir: join(stateRoot, 'pets'),
    studioWikiBaseDir: join(stateRoot, 'studio-wiki'),
    checkpointPath: join(stateRoot, 'checkpoints.json'),
    tuiCheckpointPath: join(stateRoot, 'checkpoints-tui.json'),
    tuiSessionPath: join(stateRoot, 'tui-sessions.json'),
    capabilityArtifactRoot: join(stateRoot, 'capability-artifacts'),
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
