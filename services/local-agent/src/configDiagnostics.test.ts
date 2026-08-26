import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildSetupGuide,
  formatSetupGuide,
} from './configDiagnostics';
import type { LocalAgentRuntimeConfig } from './runtimeConfig';

test('buildSetupGuide reports only Chat Host setup requirements', () => {
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
    [['llm', 'missing']],
  );
  assert.match(formatSetupGuide(guide), /models.defaultProfileId/);
  assert.match(formatSetupGuide(guide), new RegExp(escapeRegExp(runtimeConfig.workdir)));
  assert.equal(guide.checks.some((check) => check.id === 'studio-config'), false);
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

test('buildSetupGuide reports the selected local-agent workdir', () => {
  const root = join(tmpdir(), `pinpawo-setup-${randomUUID()}`);
  const runtimeConfig = runtimeConfigFor(root);

  const guide = buildSetupGuide({
    stored: { llm_api_key: 'llm-key' },
    env: {},
    runtimeConfig,
  });

  assert.equal(guide.workdir, root);
  assert.equal(guide.stateRoot, runtimeConfig.stateRoot);
  assert.equal(guide.checks.some((check) => check.id === 'studio-config'), false);
});


function runtimeConfigForMissingStudio(): LocalAgentRuntimeConfig {
  return runtimeConfigFor(join(tmpdir(), `pinpawo-missing-${randomUUID()}`));
}

function runtimeConfigFor(workdir: string): LocalAgentRuntimeConfig {
  const stateRoot = join(workdir, '.pinpawo');
  return {
    workdir,
    stateRoot,
    checkpointPath: join(stateRoot, 'checkpoints.json'),
    tuiCheckpointPath: join(stateRoot, 'checkpoints-tui.json'),
    tuiSessionPath: join(stateRoot, 'tui-sessions.json'),
    capabilityArtifactRoot: join(stateRoot, 'capability-artifacts'),
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
