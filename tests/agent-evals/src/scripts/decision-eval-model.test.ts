import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildModelProfileRegistry,
  fingerprintModelProfile,
  resolveModelProfile,
} from '../../../../services/host/src/config/modelProfiles.ts';
import type { StoredConfig } from '../../../../services/host/src/storage.ts';
import { HostChatAnthropic } from '../../../../services/host/src/agent/hostChatAnthropic.ts';
import { createDecisionEvalModel } from './decision-eval-model.ts';

function writeProfiles() {
  const root = mkdtempSync(join(tmpdir(), 'pinpawo-eval-profiles-'));
  const configPath = join(root, 'config.json');
  const stored = {
    models: {
      version: 1,
      defaultProfileId: 'endpoint-a',
      profiles: {
        'claude-native': {
          id: 'claude-native', label: 'Claude native', protocol: 'anthropic',
          model: 'claude-sonnet-4-5', baseUrl: 'https://native.example.test',
          apiKey: 'mock-native', contextWindowTokens: 200_000,
          maxOutputTokens: 1024, inputModalities: ['text', 'image'],
        },
        'claude-gateway': {
          id: 'claude-gateway', label: 'Claude gateway', provider: 'anthropic',
          model: 'claude-sonnet-4-5', baseUrl: 'https://gateway.example.test/v1',
          apiKey: 'mock-gateway', contextWindowTokens: 200_000,
          inputModalities: ['text'],
        },
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

test('eval model identity uses the canonical host profile contract', () => {
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

test('eval models preserve provider thinking defaults', () => {
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
      {},
    );
    assert.equal(evaluated.metadata.reasoningEffort, 'provider-default');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy eval effort variables do not override provider defaults', () => {
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
      {},
    );
    assert.equal(evaluated.metadata.reasoningEffort, 'provider-default');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('eval temperature is omitted by default and explicit experiment overrides remain available', () => {
  const { root, configPath } = writeProfiles();
  try {
    for (const temperature of [undefined, '0.7']) {
      const evaluated = createDecisionEvalModel({ profileId: 'deepseek-default', role: 'subject',
        env: { PROMPT_EVAL_CONFIG_PATH: configPath,
          ...(temperature === undefined ? {} : { PROMPT_EVAL_SUBJECT_TEMPERATURE: temperature }) } });
      assert.equal((evaluated.model as unknown as { temperature?: number }).temperature,
        temperature === undefined ? undefined : 0.7);
      assert.equal(evaluated.metadata.temperature, temperature === undefined ? null : 0.7);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('native eval subjects and judges use Messages while gateway Claude stays compatible', async () => {
  const { root, configPath } = writeProfiles();
  try {
    for (const role of ['subject', 'judge'] as const) {
      const evaluated = createDecisionEvalModel({ profileId: 'claude-native', role,
        env: { PROMPT_EVAL_CONFIG_PATH: configPath } });
      assert.ok(evaluated.model instanceof HostChatAnthropic);
      assert.equal(evaluated.method, 'functionCalling');
      assert.equal(evaluated.model.clientOptions.timeout, 120_000);
      evaluated.model.clientOptions.fetch = async (url, init) => {
        assert.equal(String(url), 'https://native.example.test/v1/messages');
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('x-api-key'), 'mock-native');
        assert.equal(headers.has('authorization'), false);
        assert.equal(JSON.parse(String(init?.body)).max_tokens, 1024);
        return Response.json({ id: 'mock', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 } });
      };
      await evaluated.model.invoke('Hi');
    }
    const gateway = createDecisionEvalModel({ profileId: 'claude-gateway', role: 'subject',
      env: { PROMPT_EVAL_CONFIG_PATH: configPath } });
    assert.equal(gateway.model instanceof HostChatAnthropic, false);
    for (const role of ['subject', 'judge'] as const) {
      assert.throws(() => createDecisionEvalModel({ profileId: 'claude-native', role,
        env: { PROMPT_EVAL_CONFIG_PATH: configPath,
          [role === 'subject' ? 'PROMPT_EVAL_SUBJECT_STRUCTURED_OUTPUT_METHOD' : 'PROMPT_EVAL_JUDGE_STRUCTURED_OUTPUT_METHOD']: 'jsonSchema' } }), /functionCalling only/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
