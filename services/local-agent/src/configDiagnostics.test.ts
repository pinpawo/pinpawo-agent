import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSetupGuide,
  formatSetupGuide,
  isMissingOrGeneratedApiPlaceholder,
} from './configDiagnostics';

test('buildSetupGuide reports missing required and recommended config', () => {
  const guide = buildSetupGuide({
    stored: {},
    env: {},
    configFilePath: '/tmp/pinpawo/config.json',
  });

  assert.equal(guide.readyForLocalRun, false);
  assert.deepEqual(
    guide.checks.map((check) => [check.id, check.status]),
    [
      ['llm', 'missing'],
      ['hosted-api', 'warning'],
      ['actor', 'warning'],
    ],
  );
  assert.match(formatSetupGuide(guide), /pinpawo-agent login/);
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
  });

  assert.equal(guide.readyForLocalRun, true);
  assert.equal(guide.checks.find((check) => check.id === 'llm')?.status, 'ok');
  assert.equal(guide.checks.find((check) => check.id === 'hosted-api')?.status, 'warning');
  assert.equal(guide.checks.find((check) => check.id === 'actor')?.status, 'ok');
});

test('isMissingOrGeneratedApiPlaceholder detects init scaffold values', () => {
  assert.equal(isMissingOrGeneratedApiPlaceholder('API_BASE_URL', ''), true);
  assert.equal(isMissingOrGeneratedApiPlaceholder('API_BASE_URL', 'https://your-api.example.com'), true);
  assert.equal(isMissingOrGeneratedApiPlaceholder('HASURA_ENDPOINT', 'https://your-hasura.example.com/v1/graphql'), true);
  assert.equal(isMissingOrGeneratedApiPlaceholder('AGENT_TOKEN', 'your-agent-token-here'), true);
  assert.equal(isMissingOrGeneratedApiPlaceholder('HASURA_JWT', 'eyJ...'), true);
  assert.equal(isMissingOrGeneratedApiPlaceholder('API_BASE_URL', 'https://api.example.test'), false);
});
