import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findLlmModelPresetByKey,
  inferLlmModelPreset,
  listLlmModelPresets,
} from './llmModelPresets';
import {
  buildModelProfileRegistry,
  createModelProfile,
  fingerprintModelProfile,
  LEGACY_DEFAULT_MODEL_PROFILE_ID,
  MODEL_PROFILES_VERSION,
  ModelProfileConfigError,
  parseModelProfile,
  removeLegacyModelConfigFields,
  resolveModelProfile,
  summarizeModelProfile,
  writeDefaultModelProfile,
} from './modelProfiles';
import type { StoredConfig } from './storage';
import { createLocalModelProfileRegistry } from './llmConfig';

function storedProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'primary',
    label: 'Primary',
    provider: 'example',
    model: 'example-model',
    baseUrl: 'https://models.example.test/v1',
    apiKey: 'secret-primary',
    contextWindowTokens: 64_000,
    inputModalities: ['text'],
    ...overrides,
  };
}

function storedConfig(
  profiles: Record<string, unknown>,
  defaultProfileId = 'primary',
): StoredConfig {
  return {
    models: {
      version: MODEL_PROFILES_VERSION,
      defaultProfileId,
      profiles,
    } as StoredConfig['models'],
  };
}

test('all built-in presets declare authoritative input modalities', () => {
  for (const preset of listLlmModelPresets()) {
    assert.ok(preset.inputModalities.length > 0, preset.key);
    assert.ok(preset.inputModalities.includes('text'), preset.key);
    assert.equal(new Set(preset.inputModalities).size, preset.inputModalities.length);
  }
});

test('DeepSeek V4 Flash has its own preset and does not resolve as V4 Pro', () => {
  assert.equal(findLlmModelPresetByKey('deepseek-flash')?.model, 'deepseek-v4-flash');
  assert.equal(inferLlmModelPreset('deepseek-v4-pro')?.key, 'deepseek');
  assert.equal(inferLlmModelPreset('deepseek-v4-flash')?.key, 'deepseek-flash');
});

test('Qwen 3.8 Max has a Token Plan-specific preset', () => {
  const preset = findLlmModelPresetByKey('qwen-token-plan');

  assert.equal(preset?.model, 'qwen3.8-max');
  assert.equal(preset?.baseUrl, undefined);
  assert.deepEqual(preset?.inputModalities, ['text', 'image']);
  assert.equal(preset?.contextWindowTokens, 983_616);
  assert.equal(preset?.maxOutputTokens, 131_072);
  assert.equal(inferLlmModelPreset('qwen3.8-max')?.key, 'qwen-token-plan');
  assert.equal(inferLlmModelPreset('qwen3.7-max')?.key, 'qwen');
});

test('Kimi Code K3 preset accepts image input', () => {
  const preset = findLlmModelPresetByKey('kimi-code');

  assert.equal(preset?.model, 'k3');
  assert.deepEqual(preset?.inputModalities, ['text', 'image']);
});

test('Kimi Code K3 preset refreshes image support for an existing stored profile', () => {
  const snapshot = buildModelProfileRegistry({
    stored: storedConfig({
      primary: storedProfile({
        provider: 'kimi-code',
        sourcePreset: 'kimi-code',
        model: 'k3',
        baseUrl: 'https://api.kimi.com/coding/v1',
        contextWindowTokens: 1_048_576,
        inputModalities: ['text'],
      }),
    }),
    env: {},
  });
  const registry = createLocalModelProfileRegistry({ snapshot });

  assert.deepEqual(registry.resolve().inputModalities, ['text', 'image']);
  assert.deepEqual(registry.listAvailable()[0]?.inputModalities, ['text', 'image']);
});

test('mismatched preset provenance does not refresh input modalities', () => {
  const snapshot = buildModelProfileRegistry({
    stored: storedConfig({
      primary: storedProfile({
        sourcePreset: 'kimi-code',
        model: 'custom-text-model',
        inputModalities: ['text'],
      }),
    }),
    env: {},
  });
  const registry = createLocalModelProfileRegistry({ snapshot });

  assert.deepEqual(registry.resolve().inputModalities, ['text']);
  assert.deepEqual(registry.listAvailable()[0]?.inputModalities, ['text']);
});

test('Qwen preset output limits backfill older stored profiles at runtime', () => {
  const snapshot = buildModelProfileRegistry({
    stored: storedConfig({
      primary: storedProfile({
        provider: 'aliyun',
        sourcePreset: 'qwen-token-plan',
        model: 'qwen3.8-max',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        contextWindowTokens: 983_616,
        maxOutputTokens: undefined,
        inputModalities: ['text', 'image'],
      }),
    }),
    env: {},
  });
  const registry = createLocalModelProfileRegistry({ snapshot });

  assert.equal(registry.resolve().maxOutputTokens, 131_072);
});

test('preset output limits do not leak into custom profiles with a matching model name', () => {
  const snapshot = buildModelProfileRegistry({
    stored: storedConfig({
      primary: storedProfile({
        model: 'qwen3.8-max',
        sourcePreset: undefined,
        maxOutputTokens: undefined,
      }),
    }),
    env: {},
  });
  const registry = createLocalModelProfileRegistry({ snapshot });

  assert.equal(registry.resolve().maxOutputTokens, undefined);
});

test('custom profiles default missing modality metadata to text-only', () => {
  const parsed = parseModelProfile(storedProfile({
    inputModalities: undefined,
  }));

  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(parsed.profile?.inputModalities, ['text']);
});

test('stored profiles may derive provider metadata from their endpoint', () => {
  const parsed = parseModelProfile(storedProfile({
    provider: undefined,
  }));

  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.profile?.provider, 'models.example.test');
});

test('custom profile creation never infers image support from a model name', () => {
  const profile = createModelProfile({
    id: 'custom-gpt',
    label: 'Custom GPT',
    apiKey: 'secret',
    baseUrl: 'https://custom.example.test/v1',
    model: 'gpt-5.5',
    contextWindowTokens: 32_000,
  });

  assert.deepEqual(profile.inputModalities, ['text']);
  assert.equal(profile.sourcePreset, undefined);
});

test('stored registry isolates an invalid non-default profile with diagnostics', () => {
  const registry = buildModelProfileRegistry({
    stored: storedConfig({
      primary: storedProfile(),
      broken: storedProfile({
        id: 'broken',
        baseUrl: 'not-a-url',
      }),
    }),
    env: {},
  });

  assert.equal(registry.defaultProfileId, 'primary');
  assert.equal(registry.selectedProfileId, 'primary');
  assert.deepEqual(Object.keys(registry.profiles), ['primary']);
  assert.match(registry.unavailableProfiles.broken?.[0]?.message ?? '', /baseUrl/);
});

test('registry lookups do not resolve inherited object properties as profiles', () => {
  assert.throws(
    () => buildModelProfileRegistry({
      stored: storedConfig({
        primary: storedProfile(),
      }),
      env: {
        PINPAWO_MODEL_PROFILE: 'constructor',
      },
    }),
    /Selected model profile "constructor" does not exist/,
  );
});

test('stored profile ids that match object internals remain ordinary own keys', () => {
  const profiles = {
    primary: storedProfile(),
    constructor: storedProfile({
      id: 'constructor',
      label: 'Constructor',
    }),
  };
  const registry = buildModelProfileRegistry({
    stored: storedConfig(profiles),
    env: {
      PINPAWO_MODEL_PROFILE: 'constructor',
    },
  });

  assert.equal(resolveModelProfile(registry).id, 'constructor');
  assert.equal(Object.hasOwn(registry.profiles, 'constructor'), true);
});

test('stored profiles may use the env id and environment model values are ignored', () => {
  const registry = buildModelProfileRegistry({
    stored: storedConfig({
      env: storedProfile({
        id: 'env',
        label: 'Environment named profile',
      }),
    }, 'env'),
    env: {
      LLM_API_KEY: 'ignored-secret',
      LLM_BASE_URL: 'https://ignored.example.test/v1',
      LLM_MODEL: 'ignored-model',
    },
  });

  assert.equal(registry.selectedProfileId, 'env');
  assert.equal(resolveModelProfile(registry).apiKey, 'secret-primary');
});

test('invalid configured default blocks resolution instead of falling back', () => {
  assert.throws(
    () => buildModelProfileRegistry({
      stored: storedConfig({
        primary: storedProfile({ apiKey: '' }),
        secondary: storedProfile({ id: 'secondary' }),
      }),
      env: {},
    }),
    (error: unknown) => (
      error instanceof ModelProfileConfigError
      && error.profileId === 'primary'
      && /Default model profile/.test(error.message)
    ),
  );
});

test('legacy singleton config synthesizes a legacy-default profile', () => {
  const registry = buildModelProfileRegistry({
    stored: {
      llm_api_key: 'legacy-secret',
      llm_model_preset: 'gemini',
      llm_base_url: 'https://gateway.example.test/v1',
      llm_model: 'gemini-3.5-flash',
      llm_context_window_tokens: 99_000,
    },
    env: {},
  });
  const profile = resolveModelProfile(registry);

  assert.equal(profile.id, LEGACY_DEFAULT_MODEL_PROFILE_ID);
  assert.equal(profile.sourcePreset, 'gemini');
  assert.deepEqual(profile.inputModalities, ['text', 'image']);
  assert.equal(profile.contextWindowTokens, 99_000);
});

test('custom legacy config is conservatively text-only', () => {
  const registry = buildModelProfileRegistry({
    stored: {
      llm_api_key: 'legacy-secret',
      llm_base_url: 'https://custom.example.test/v1',
      llm_model: 'unknown-vision-sounding-model',
      llm_context_window_tokens: 32_000,
    },
    env: {},
  });

  assert.deepEqual(resolveModelProfile(registry).inputModalities, ['text']);
});

test('mismatched legacy preset provenance does not grant image support', () => {
  const registry = buildModelProfileRegistry({
    stored: {
      llm_api_key: 'legacy-secret',
      llm_model_preset: 'gemini',
      llm_base_url: 'https://custom.example.test/v1',
      llm_model: 'unknown-custom-model',
      llm_context_window_tokens: 32_000,
    },
    env: {},
  });
  const profile = resolveModelProfile(registry);

  assert.equal(profile.sourcePreset, undefined);
  assert.deepEqual(profile.inputModalities, ['text']);
});

test('profile summaries and fingerprints never include credentials', () => {
  const profile = createModelProfile({
    id: 'private',
    label: 'Private',
    apiKey: 'top-secret',
    baseUrl: 'https://user:password@models.example.test/v1?token=query-secret',
    model: 'custom-model',
    contextWindowTokens: 32_000,
  });
  const summaryText = JSON.stringify(summarizeModelProfile(profile));
  const fingerprintText = JSON.stringify(fingerprintModelProfile(profile));

  assert.equal(summarizeModelProfile(profile).endpointHost, 'models.example.test');
  assert.doesNotMatch(summaryText, /top-secret|password|query-secret/);
  assert.doesNotMatch(fingerprintText, /top-secret|password|query-secret/);
});

test('fingerprint changes with endpoint behavior but not API key', () => {
  const first = createModelProfile({
    id: 'first',
    label: 'First',
    apiKey: 'secret-a',
    baseUrl: 'https://one.example.test/v1',
    model: 'same-model',
    contextWindowTokens: 32_000,
  });
  const second = createModelProfile({
    id: 'second',
    label: 'Second',
    apiKey: 'secret-b',
    baseUrl: 'https://one.example.test/v1',
    model: 'same-model',
    contextWindowTokens: 32_000,
  });
  const otherEndpoint = createModelProfile({
    id: 'third',
    label: 'Third',
    apiKey: 'secret-a',
    baseUrl: 'https://two.example.test/v1',
    model: 'same-model',
    contextWindowTokens: 32_000,
  });

  assert.equal(
    fingerprintModelProfile(first).fingerprint,
    fingerprintModelProfile(second).fingerprint,
  );
  assert.notEqual(
    fingerprintModelProfile(first).fingerprint,
    fingerprintModelProfile(otherEndpoint).fingerprint,
  );
});

test('legacy model fields are removed when versioned profiles are persisted', () => {
  const original: StoredConfig = {
    llm_api_key: 'secret',
    llm_model_preset: 'deepseek',
    llm_base_url: 'https://api.deepseek.com',
    llm_model: 'deepseek-v4-pro',
    llm_observe_model: 'deepseek-v4-pro',
    llm_context_window_tokens: 1_000_000,
    actor_id: 'actor-1',
  };
  const migrated = removeLegacyModelConfigFields(original);

  assert.equal(migrated.actor_id, 'actor-1');
  assert.equal('llm_api_key' in migrated, false);
  assert.equal('llm_model_preset' in migrated, false);
  assert.equal('llm_base_url' in migrated, false);
  assert.equal('llm_model' in migrated, false);
  assert.equal('llm_observe_model' in migrated, false);
  assert.equal('llm_context_window_tokens' in migrated, false);
});

test('default model profile write migrates legacy fields and preserves peer profiles', () => {
  const existingPrimary = createModelProfile({
    id: 'primary',
    label: 'Primary',
    apiKey: 'primary-secret',
    baseUrl: 'https://primary.example.test/v1',
    model: 'primary-model',
    contextWindowTokens: 64_000,
  });
  const secondary = createModelProfile({
    id: 'secondary',
    label: 'Secondary',
    apiKey: 'secondary-secret',
    baseUrl: 'https://secondary.example.test/v1',
    model: 'secondary-model',
    contextWindowTokens: 64_000,
  });
  const stored = {
    llm_api_key: 'legacy-secret',
    llm_model: 'legacy-model',
    models: {
      version: MODEL_PROFILES_VERSION,
      defaultProfileId: 'primary',
      profiles: {
        primary: existingPrimary,
        secondary,
      },
    },
  } satisfies StoredConfig;
  const replacement = createModelProfile({
    id: 'primary',
    label: 'Replacement',
    apiKey: 'replacement-secret',
    baseUrl: 'https://replacement.example.test/v1',
    model: 'replacement-model',
    contextWindowTokens: 128_000,
  });

  const migrated = writeDefaultModelProfile(stored, replacement);

  assert.equal('llm_api_key' in migrated, false);
  assert.equal('llm_model' in migrated, false);
  assert.equal(migrated.models?.profiles.primary.label, 'Replacement');
  assert.equal(migrated.models?.profiles.secondary.label, 'Secondary');
});
