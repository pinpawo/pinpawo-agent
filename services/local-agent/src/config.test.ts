import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const REQUIRED_ENV = {
  API_BASE_URL: 'https://example.test',
  HASURA_ENDPOINT: 'https://example.test/v1/graphql',
  AGENT_TOKEN: 'agent-token',
  HASURA_JWT: 'hasura-jwt',
  LLM_API_KEY: 'llm-key',
};

async function loadConfigHelpers() {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    process.env[key] = value;
  }
  return import('./config');
}

test('resolveNumberConfigValue falls back to stored number for empty env values', async () => {
  const { resolveNumberConfigValue } = await loadConfigHelpers();
  assert.equal(resolveNumberConfigValue('', 131072), 131072);
  assert.equal(resolveNumberConfigValue('   ', 131072), 131072);
});

test('resolveNumberConfigValue prefers valid env number over stored number', async () => {
  const { resolveNumberConfigValue } = await loadConfigHelpers();
  assert.equal(resolveNumberConfigValue('64000', 131072), 64000);
});

test('isMissingOrGeneratedApiPlaceholder detects init scaffold values', async () => {
  const { isMissingOrGeneratedApiPlaceholder } = await loadConfigHelpers();

  assert.equal(isMissingOrGeneratedApiPlaceholder('API_BASE_URL', ''), true);
  assert.equal(isMissingOrGeneratedApiPlaceholder('API_BASE_URL', 'https://your-api.example.com'), true);
  assert.equal(isMissingOrGeneratedApiPlaceholder('HASURA_ENDPOINT', 'https://your-hasura.example.com/v1/graphql'), true);
  assert.equal(isMissingOrGeneratedApiPlaceholder('AGENT_TOKEN', 'your-agent-token-here'), true);
  assert.equal(isMissingOrGeneratedApiPlaceholder('HASURA_JWT', 'eyJ...'), true);
  assert.equal(isMissingOrGeneratedApiPlaceholder('API_BASE_URL', 'https://api.example.test'), false);
});

test('config workdir defaults to process cwd when env and stored config are absent', () => {
  const home = mkdtempSync(resolve(tmpdir(), 'pinpawo-config-home-'));
  const output = execFileSync(process.execPath, [
    '--import',
    'tsx',
    '-e',
    [
      'const { config } = await import("./services/local-agent/src/config.ts");',
      'process.stdout.write(config.workdir);',
    ].join('\n'),
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      PINPAWO_WORKDIR: '',
      LLM_API_KEY: 'llm-key',
    },
    encoding: 'utf8',
  });

  assert.equal(output, process.cwd());
});
