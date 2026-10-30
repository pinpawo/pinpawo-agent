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
import { createLocalModelProfileRegistry } from '../../../../services/host/src/config/llmConfig.ts';
import type { StoredConfig } from '../../../../services/host/src/storage.ts';
import type { ReasoningPassbackCompletions } from '../../../../services/host/src/agent/reasoningPassback.ts';
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
        'claude-preset': {
          id: 'claude-preset', label: 'Claude preset', protocol: 'anthropic',
          sourcePreset: 'claude-sonnet', model: 'claude-sonnet-4-6',
          baseUrl: 'https://native.example.test', apiKey: 'mock-native',
          contextWindowTokens: 200_000, inputModalities: ['text'],
        },
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
    const cases = (['subject', 'judge'] as const).flatMap(role =>
      [undefined, '0.7'].map(temperature => ({ role, temperature })));
    for (const { role, temperature } of cases) {
      const evaluated = createDecisionEvalModel({ profileId: 'claude-native', role,
        env: { PROMPT_EVAL_CONFIG_PATH: configPath,
          ...(temperature === undefined ? {} : {
            [role === 'subject' ? 'PROMPT_EVAL_SUBJECT_TEMPERATURE' : 'PROMPT_EVAL_JUDGE_TEMPERATURE']: temperature,
          }) } });
      assert.ok(evaluated.model instanceof HostChatAnthropic);
      assert.equal(evaluated.method, 'functionCalling');
      assert.equal(evaluated.model.clientOptions.timeout, 120_000);
      evaluated.model.clientOptions.fetch = async (url, init) => {
        assert.equal(String(url), 'https://native.example.test/v1/messages');
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('x-api-key'), 'mock-native');
        assert.equal(headers.has('authorization'), false);
        const body = JSON.parse(String(init?.body));
        assert.equal(body.max_tokens, 1024);
        assert.equal(body.temperature, temperature === undefined ? undefined : 0.7);
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


test('eval temperature overrides reach OpenAI completion requests for subjects and judges', async () => {
  const { root, configPath } = writeProfiles();
  try {
    for (const role of ['subject', 'judge'] as const) {
      for (const temperature of [undefined, '0.7']) {
        const evaluated = createDecisionEvalModel({ profileId: 'endpoint-b', role,
          env: { PROMPT_EVAL_CONFIG_PATH: configPath,
            ...(temperature === undefined ? {} : {
              [role === 'subject' ? 'PROMPT_EVAL_SUBJECT_TEMPERATURE' : 'PROMPT_EVAL_JUDGE_TEMPERATURE']: temperature,
            }) } });
        const completions = (evaluated.model as unknown as { completions: ReasoningPassbackCompletions }).completions;
        let requested = false;
        completions.clientConfig.fetch = async (url, init) => {
          requested = true;
          assert.equal(String(url), 'https://b.example.test/v1/chat/completions');
          const body = JSON.parse(String(init?.body));
          assert.equal(body.temperature, temperature === undefined ? undefined : 0.7);
          return Response.json({ id: 'mock', object: 'chat.completion', created: 0, model: 'same-model',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
        };
        await evaluated.model.invoke('Hi');
        assert.equal(requested, true);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('eval requests and metadata use Host-resolved preset output limits and modalities', async () => {
  const { root, configPath, stored } = writeProfiles();
  try {
    const snapshot = buildModelProfileRegistry({
      stored: stored as unknown as StoredConfig,
      env: { PINPAWO_MODEL_PROFILE: 'claude-preset' },
    });
    const host = createLocalModelProfileRegistry({ snapshot }).resolve('claude-preset');
    const evaluated = createDecisionEvalModel({ profileId: 'claude-preset', role: 'subject',
      env: { PROMPT_EVAL_CONFIG_PATH: configPath } });
    assert.ok(evaluated.model instanceof HostChatAnthropic);
    assert.equal(host.maxOutputTokens, 64_000);
    assert.equal(evaluated.metadata.maxOutputTokens, host.maxOutputTokens);
    assert.deepEqual(host.inputModalities, ['text', 'image']);
    assert.deepEqual(evaluated.metadata.inputModalities, host.inputModalities);
    assert.equal(evaluated.metadata.fingerprint, host.modelProfileFingerprint);
    let requested = false;
    evaluated.model.clientOptions.fetch = async (_url, init) => {
      requested = true;
      const request = JSON.parse(String(init?.body));
      assert.equal(request.max_tokens, host.maxOutputTokens);
      return Response.json({ id: 'mock', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } });
    };
    await evaluated.model.invoke('Hi');
    assert.equal(requested, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
