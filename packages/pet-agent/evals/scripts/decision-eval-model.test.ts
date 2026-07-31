import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildModelProfileRegistry,
  fingerprintModelProfile,
  resolveModelProfile,
} from '../../../../services/local-agent/src/modelProfiles.ts';
import type { StoredConfig } from '../../../../services/local-agent/src/storage.ts';
import { createDecisionEvalModel } from './decision-eval-model.ts';

function writeProfiles() {
  const root = mkdtempSync(join(tmpdir(), 'pinpawo-eval-profiles-'));
  const configPath = join(root, 'config.json');
  const stored = {
    models: {
      version: 1,
      defaultProfileId: 'endpoint-a',
      profiles: {
        'endpoint-a': {
          id: 'endpoint-a',
          label: 'Endpoint A',
          model: 'same-model',
          baseUrl: 'https://a.example.test/v1/secret-path-a?secret=query',
          apiKey: 'secret-a',
          contextWindowTokens: 32_000,
          structuredOutputMethod: 'jsonSchema',
          inputModalities: ['text'],
        },
        'endpoint-b': {
          id: 'endpoint-b',
          label: 'Endpoint B',
          provider: 'test',
          model: 'same-model',
          baseUrl: 'https://b.example.test/v1',
          apiKey: 'secret-b',
          contextWindowTokens: 32_000,
          structuredOutputMethod: 'jsonSchema',
          inputModalities: ['text', 'image'],
        },
        'preset-derived': {
          id: 'preset-derived',
          label: 'Preset-derived provider',
          sourcePreset: 'qwen',
          model: 'qwen3.7-max',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          apiKey: 'secret-preset',
          contextWindowTokens: 1_000_000,
          inputModalities: ['text'],
        },
        'deepseek-default': {
          id: 'deepseek-default',
          label: 'DeepSeek default',
          sourcePreset: 'deepseek',
          model: 'deepseek-v4-pro',
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'secret-deepseek',
          contextWindowTokens: 1_000_000,
          inputModalities: ['text'],
        },
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(stored), 'utf8');
  return { root, configPath, stored };
}

test('eval model profiles preserve stable identities without projecting secrets', () => {
  const { root, configPath } = writeProfiles();
  try {
    const subject = createDecisionEvalModel({
      profileId: 'endpoint-a',
      role: 'subject',
      env: {
        PROMPT_EVAL_CONFIG_PATH: configPath,
      },
    });
    const judge = createDecisionEvalModel({
      profileId: 'endpoint-b',
      role: 'judge',
      env: {
        PROMPT_EVAL_CONFIG_PATH: configPath,
      },
    });

    assert.equal(subject.metadata.profileId, 'endpoint-a');
    assert.equal(subject.metadata.role, 'subject');
    assert.equal(subject.metadata.provider, 'a.example.test');
    assert.equal(subject.metadata.endpointOrigin, 'https://a.example.test');
    assert.deepEqual(judge.metadata.inputModalities, ['text', 'image']);
    assert.equal(
      (subject.model as unknown as {
        clientConfig: { baseURL: string };
      }).clientConfig.baseURL,
      'https://a.example.test/v1/secret-path-a?secret=query',
      'the runnable profile must keep endpoint path and query parameters',
    );
    assert.notEqual(
      subject.metadata.fingerprint,
      judge.metadata.fingerprint,
      'same model names on different endpoints need distinct fingerprints',
    );
    const projected = JSON.stringify([subject.metadata, judge.metadata]);
    assert.doesNotMatch(
      projected,
      /secret-a|secret-b|secret-path-a|secret=query/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('eval model identity uses the canonical local-agent profile contract', () => {
  const { root, configPath, stored } = writeProfiles();
  try {
    const evaluated = createDecisionEvalModel({
      profileId: 'preset-derived',
      role: 'subject',
      env: {
        PROMPT_EVAL_CONFIG_PATH: configPath,
      },
    });
    const registry = buildModelProfileRegistry({
      stored: stored as unknown as StoredConfig,
      env: {
        PINPAWO_MODEL_PROFILE: 'preset-derived',
      },
    });
    const hostProfile = resolveModelProfile(registry, 'preset-derived');

    assert.equal(evaluated.metadata.provider, 'aliyun');
    assert.equal(
      evaluated.metadata.fingerprint,
      fingerprintModelProfile(hostProfile).fingerprint,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('eval model resolution requires an explicit configured profile', () => {
  const { root, configPath } = writeProfiles();
  try {
    assert.throws(
      () => createDecisionEvalModel({
        profileId: 'missing',
        role: 'subject',
        env: { PROMPT_EVAL_CONFIG_PATH: configPath },
      }),
      /Unknown model profile "missing"/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('eval models use the production default thinking control', () => {
  const { root, configPath } = writeProfiles();
  try {
    const evaluated = createDecisionEvalModel({
      profileId: 'deepseek-default',
      role: 'subject',
      env: {
        PROMPT_EVAL_CONFIG_PATH: configPath,
      },
    });

    assert.deepEqual(
      (evaluated.model as unknown as {
        modelKwargs: Record<string, unknown>;
      }).modelKwargs,
      { thinking: { type: 'disabled' } },
    );
    assert.equal(evaluated.metadata.reasoningEffort, 'disabled');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('explicit eval reasoning effort overrides the production default', () => {
  const { root, configPath } = writeProfiles();
  try {
    const evaluated = createDecisionEvalModel({
      profileId: 'deepseek-default',
      role: 'subject',
      env: {
        PROMPT_EVAL_CONFIG_PATH: configPath,
        PROMPT_EVAL_SUBJECT_REASONING_EFFORT: 'low',
      },
    });

    assert.deepEqual(
      (evaluated.model as unknown as {
        modelKwargs: Record<string, unknown>;
      }).modelKwargs,
      { reasoning_effort: 'low' },
    );
    assert.equal(evaluated.metadata.reasoningEffort, 'low');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
