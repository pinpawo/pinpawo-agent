import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildSetupGuide,
  formatSetupGuide,
  isMissingOrGeneratedApiPlaceholder,
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
      ['hosted-api', 'warning'],
      ['actor', 'warning'],
      ['studio-config', 'warning'],
    ],
  );
  assert.match(formatSetupGuide(guide), /pinpawo-agent login/);
  assert.match(formatSetupGuide(guide), new RegExp(escapeRegExp(runtimeConfig.workdir)));
  const studioCheck = guide.checks.find((check) => check.id === 'studio-config');
  assert.equal(studioCheck?.nextStep, `Create ${runtimeConfig.studioConfigPath}.`);
  assert.doesNotMatch(formatSetupGuide(guide), /studio migrate/);
});

test('buildSetupGuide accepts local-ready config without hosted API', () => {
  const guide = buildSetupGuide({
    stored: {
      llm_api_key: 'llm-key',
      actor_id: 'local-only',
      actor_name: 'Local Agent',
    },
    env: {},
    configFilePath: '/tmp/pinpawo/config.json',
    runtimeConfig: runtimeConfigForMissingStudio(),
  });

  assert.equal(guide.readyForLocalRun, true);
  assert.equal(guide.checks.find((check) => check.id === 'llm')?.status, 'ok');
  assert.equal(guide.checks.find((check) => check.id === 'hosted-api')?.status, 'warning');
  assert.equal(guide.checks.find((check) => check.id === 'actor')?.status, 'ok');
});

test('buildSetupGuide reports local-only override when hosted API credentials exist', () => {
  const guide = buildSetupGuide({
    stored: {
      llm_api_key: 'llm-key',
      api_base_url: 'https://api.example.test',
      hasura_endpoint: 'https://hasura.example.test/v1/graphql',
      agent_token: 'agent-token',
      hasura_jwt: 'hasura-jwt',
      local_only: true,
    },
    env: {},
    configFilePath: '/tmp/pinpawo/config.json',
    runtimeConfig: runtimeConfigForMissingStudio(),
  });

  const hostedApi = guide.checks.find((check) => check.id === 'hosted-api');
  const actor = guide.checks.find((check) => check.id === 'actor');

  assert.equal(hostedApi?.status, 'warning');
  assert.match(hostedApi?.detail ?? '', /PINPAWO_LOCAL_ONLY is enabled/);
  assert.equal(actor?.status, 'warning');
  assert.match(actor?.detail ?? '', /Local-only mode/);
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

test('isMissingOrGeneratedApiPlaceholder detects init scaffold values', () => {
  assert.equal(isMissingOrGeneratedApiPlaceholder('API_BASE_URL', ''), true);
  assert.equal(isMissingOrGeneratedApiPlaceholder('API_BASE_URL', 'https://your-api.example.com'), true);
  assert.equal(isMissingOrGeneratedApiPlaceholder('HASURA_ENDPOINT', 'https://your-hasura.example.com/v1/graphql'), true);
  assert.equal(isMissingOrGeneratedApiPlaceholder('AGENT_TOKEN', 'your-agent-token-here'), true);
  assert.equal(isMissingOrGeneratedApiPlaceholder('HASURA_JWT', 'eyJ...'), true);
  assert.equal(isMissingOrGeneratedApiPlaceholder('API_BASE_URL', 'https://api.example.test'), false);
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
