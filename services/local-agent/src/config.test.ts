import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const CONFIG_IMPORT_PATH = process.cwd().endsWith('services/local-agent')
  ? './src/config.ts'
  : './services/local-agent/src/config.ts';

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
      `const { getConfig } = await import(${JSON.stringify(CONFIG_IMPORT_PATH)});`,
      'process.stdout.write(getConfig().workdir);',
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

test('PINPAWO_LOCAL_ONLY disables hosted API even when credentials are present', () => {
  const home = mkdtempSync(resolve(tmpdir(), 'pinpawo-config-home-'));
  const output = execFileSync(process.execPath, [
    '--import',
    'tsx',
    '-e',
    [
      `const { getConfig } = await import(${JSON.stringify(CONFIG_IMPORT_PATH)});`,
      'const config = getConfig();',
      'process.stdout.write(JSON.stringify({ apiConnected: config.apiConnected, localOnlyMode: config.localOnlyMode, apiSetupMessage: config.apiSetupMessage }));',
    ].join('\n'),
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...REQUIRED_ENV,
      HOME: home,
      PINPAWO_LOCAL_ONLY: '1',
    },
    encoding: 'utf8',
  });

  const parsed = JSON.parse(output) as {
    apiConnected: boolean;
    localOnlyMode: boolean;
    apiSetupMessage: string;
  };
  assert.equal(parsed.apiConnected, false);
  assert.equal(parsed.localOnlyMode, true);
  assert.match(parsed.apiSetupMessage, /Local-only mode is enabled/);
});

test('setConfig replaces the current frozen snapshot without mutating previous snapshots', async () => {
  const { getConfig, setConfig } = await loadConfigHelpers();
  const original = getConfig();

  try {
    const updated = setConfig((current) => ({
      workdir: `${current.workdir}-updated`,
    }));

    assert.notEqual(updated, original);
    assert.equal(getConfig(), updated);
    assert.equal(original.workdir.endsWith('-updated'), false);
    assert.equal(updated.workdir, `${original.workdir}-updated`);
    assert.equal(Object.isFrozen(updated), true);
  } finally {
    setConfig(original);
  }
});
