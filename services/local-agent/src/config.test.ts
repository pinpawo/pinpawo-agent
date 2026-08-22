import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const CONFIG_IMPORT_PATH = process.cwd().endsWith('services/local-agent')
  ? './src/config.ts'
  : './services/local-agent/src/config.ts';

const REQUIRED_ENV = {
  LLM_API_KEY: 'llm-key',
  LLM_BASE_URL: 'https://models.example.test/v1',
  LLM_MODEL: 'test-model',
};

function readGlobalReviewPolicyMode(
  home: string,
  env: Record<string, string> = {},
) {
  return execFileSync(process.execPath, [
    '--import',
    'tsx',
    '-e',
    [
      `const { getConfig } = await import(${JSON.stringify(CONFIG_IMPORT_PATH)});`,
      'process.stdout.write(getConfig().globalReviewPolicyMode);',
    ].join('\n'),
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...REQUIRED_ENV,
      HOME: home,
      PINPAWO_GLOBAL_REVIEW_POLICY: '',
      PINPAWO_REVIEW_POLICY_STRATEGY: '',
      ...env,
    },
    encoding: 'utf8',
  });
}

function readAutoAuthorizationSafetyLevel(home: string) {
  return execFileSync(process.execPath, [
    '--import',
    'tsx',
    '-e',
    [
      `const { getConfig } = await import(${JSON.stringify(CONFIG_IMPORT_PATH)});`,
      'process.stdout.write(getConfig().autoAuthorizationSafetyLevel);',
    ].join('\n'),
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...REQUIRED_ENV,
      HOME: home,
    },
    encoding: 'utf8',
  });
}

function writeStoredConfig(home: string, config: Record<string, unknown>) {
  const configDir = resolve(home, '.pinpawo');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(resolve(configDir, 'config.json'), JSON.stringify(config));
}

async function loadConfigHelpers() {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    process.env[key] = value;
  }
  return import('./config');
}

test('importing config does not require a model profile until config is read', () => {
  const home = mkdtempSync(resolve(tmpdir(), 'pinpawo-config-import-home-'));
  const output = execFileSync(process.execPath, [
    '--import',
    'tsx',
    '-e',
    [
      `await import(${JSON.stringify(CONFIG_IMPORT_PATH)});`,
      "process.stdout.write('imported');",
    ].join('\n'),
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      LLM_API_KEY: '',
      LLM_BASE_URL: '',
      LLM_MODEL: '',
    },
    encoding: 'utf8',
  });

  assert.equal(output, 'imported');
});

test('resolveNumberConfigValue falls back to stored number for empty env values', async () => {
  const { resolveNumberConfigValue } = await loadConfigHelpers();
  assert.equal(resolveNumberConfigValue('', 131072), 131072);
  assert.equal(resolveNumberConfigValue('   ', 131072), 131072);
});

test('resolveNumberConfigValue prefers valid env number over stored number', async () => {
  const { resolveNumberConfigValue } = await loadConfigHelpers();
  assert.equal(resolveNumberConfigValue('64000', 131072), 64000);
});

test('Capability registry backend is explicit and rejects unknown values', async () => {
  const { resolveCapabilityRegistryBackend } = await loadConfigHelpers();
  assert.equal(resolveCapabilityRegistryBackend(undefined), undefined);
  assert.equal(resolveCapabilityRegistryBackend('filesystem'), 'filesystem');
  assert.equal(resolveCapabilityRegistryBackend(' MEMORY '), 'memory');
  assert.throws(
    () => resolveCapabilityRegistryBackend('auto'),
    /filesystem.*memory/,
  );
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
      LLM_BASE_URL: 'https://models.example.test/v1',
      LLM_MODEL: 'test-model',
    },
    encoding: 'utf8',
  });

  assert.equal(output, process.cwd());
});


test('config ignores the removed PINPAWO_REVIEW_POLICY_STRATEGY environment alias', () => {
  const home = mkdtempSync(resolve(tmpdir(), 'pinpawo-config-home-'));
  assert.equal(
    readGlobalReviewPolicyMode(home, { PINPAWO_REVIEW_POLICY_STRATEGY: 'full_access' }),
    'require_authorization',
  );
});

test('config ignores the removed review_policy_strategy stored key', () => {
  const home = mkdtempSync(resolve(tmpdir(), 'pinpawo-config-home-'));
  writeStoredConfig(home, {
    review_policy_strategy: 'full_access',
  });

  assert.equal(readGlobalReviewPolicyMode(home), 'require_authorization');
});

test('config still accepts the canonical global review policy setting', () => {
  const home = mkdtempSync(resolve(tmpdir(), 'pinpawo-config-home-'));
  assert.equal(
    readGlobalReviewPolicyMode(home, { PINPAWO_GLOBAL_REVIEW_POLICY: 'auto_authorization' }),
    'auto_authorization',
  );
});

test('config still accepts the canonical global_review_policy stored key', () => {
  const home = mkdtempSync(resolve(tmpdir(), 'pinpawo-config-home-'));
  writeStoredConfig(home, {
    global_review_policy: 'full_access',
  });

  assert.equal(readGlobalReviewPolicyMode(home), 'full_access');
});

test('auto authorization safety level defaults to strict and reads the stored relaxed value', () => {
  const defaultHome = mkdtempSync(resolve(tmpdir(), 'pinpawo-config-home-'));
  assert.equal(readAutoAuthorizationSafetyLevel(defaultHome), 'strict');

  const configuredHome = mkdtempSync(resolve(tmpdir(), 'pinpawo-config-home-'));
  writeStoredConfig(configuredHome, {
    auto_authorization_safety_level: 'relaxed',
  });
  assert.equal(readAutoAuthorizationSafetyLevel(configuredHome), 'relaxed');
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

test('config resolves a stored versioned model profile without legacy singleton fields', () => {
  const home = mkdtempSync(resolve(tmpdir(), 'pinpawo-config-home-'));
  writeStoredConfig(home, {
    models: {
      version: 1,
      defaultProfileId: 'primary',
      profiles: {
        primary: {
          id: 'primary',
          label: 'Primary',
          provider: 'example',
          model: 'stored-model',
          baseUrl: 'https://stored.example.test/v1',
          apiKey: 'stored-secret',
          contextWindowTokens: 128000,
          inputModalities: ['text'],
        },
      },
    },
  });

  const output = execFileSync(process.execPath, [
    '--import',
    'tsx',
    '-e',
    [
      `const { getConfig } = await import(${JSON.stringify(CONFIG_IMPORT_PATH)});`,
      'const config = getConfig();',
      'process.stdout.write(JSON.stringify({ id: config.modelProfileId, fingerprint: config.modelProfileFingerprint }));',
    ].join('\n'),
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      LLM_API_KEY: '',
      LLM_BASE_URL: '',
      LLM_MODEL: '',
      LLM_MODEL_PRESET: '',
      PINPAWO_MODEL_PROFILE: '',
    },
    encoding: 'utf8',
  });

  const parsed = JSON.parse(output) as {
    id: string;
    fingerprint: string;
  };
  assert.equal(parsed.id, 'primary');
  assert.match(parsed.fingerprint, /^[a-f0-9]{64}$/);
});

test('config never combines a partial environment override with a stored profile', () => {
  const home = mkdtempSync(resolve(tmpdir(), 'pinpawo-config-home-'));
  writeStoredConfig(home, {
    models: {
      version: 1,
      defaultProfileId: 'primary',
      profiles: {
        primary: {
          id: 'primary',
          label: 'Primary',
          provider: 'example',
          model: 'stored-model',
          baseUrl: 'https://stored.example.test/v1',
          apiKey: 'stored-secret',
          contextWindowTokens: 128000,
          inputModalities: ['text'],
        },
      },
    },
  });

  const output = execFileSync(process.execPath, [
    '--import',
    'tsx',
    '-e',
    [
      `const { buildLocalLlmConfig } = await import(${JSON.stringify(CONFIG_IMPORT_PATH.replace('config.ts', 'llmConfig.ts'))});`,
      'const config = buildLocalLlmConfig();',
      'process.stdout.write(JSON.stringify({ model: config.model, baseUrl: config.baseUrl, apiKey: config.apiKey }));',
    ].join('\n'),
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      LLM_API_KEY: 'wrong-provider-secret',
      LLM_BASE_URL: '',
      LLM_MODEL: '',
      LLM_MODEL_PRESET: '',
      PINPAWO_MODEL_PROFILE: '',
    },
    encoding: 'utf8',
  });

  assert.deepEqual(JSON.parse(output), {
    model: 'stored-model',
    baseUrl: 'https://stored.example.test/v1',
    apiKey: 'stored-secret',
  });
});
