import assert from 'node:assert/strict';
import test from 'node:test';
import { MODEL_PROFILES_VERSION } from '../modelProfiles';
import type { StoredConfig } from '../storage';
import { resolveLoginDefaultModelProfile } from './login';

function profile(id: string, model: string, apiKey: string) {
  return {
    id,
    label: id,
    provider: 'example',
    model,
    baseUrl: `https://${id}.example.test/v1`,
    apiKey,
    contextWindowTokens: 64_000,
    inputModalities: ['text'] as const,
  };
}

test('login edits the configured default instead of the selected runtime profile', () => {
  const stored = {
    models: {
      version: MODEL_PROFILES_VERSION,
      defaultProfileId: 'primary',
      profiles: {
        primary: profile('primary', 'primary-model', 'primary-secret'),
        secondary: profile('secondary', 'secondary-model', 'secondary-secret'),
      },
    },
  } satisfies StoredConfig;

  const selectedStoredProfile = resolveLoginDefaultModelProfile(stored, {
    PINPAWO_MODEL_PROFILE: 'secondary',
  });
  const unknownSelectedProfile = resolveLoginDefaultModelProfile(stored, {
    PINPAWO_MODEL_PROFILE: 'missing',
  });
  const selectedEnvironmentProfile = resolveLoginDefaultModelProfile(stored, {
    LLM_API_KEY: 'environment-secret',
    LLM_BASE_URL: 'https://environment.example.test/v1',
    LLM_MODEL: 'environment-model',
  });

  assert.equal(selectedStoredProfile?.id, 'primary');
  assert.equal(selectedStoredProfile?.model, 'primary-model');
  assert.equal(selectedStoredProfile?.apiKey, 'primary-secret');
  assert.equal(unknownSelectedProfile?.id, 'primary');
  assert.equal(unknownSelectedProfile?.model, 'primary-model');
  assert.equal(unknownSelectedProfile?.apiKey, 'primary-secret');
  assert.equal(selectedEnvironmentProfile?.id, 'primary');
  assert.equal(selectedEnvironmentProfile?.model, 'primary-model');
  assert.equal(selectedEnvironmentProfile?.apiKey, 'primary-secret');
});
