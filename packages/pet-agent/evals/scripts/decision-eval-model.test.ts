import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDecisionEvalModel } from './decision-eval-model.ts';

function writeProfiles() {
  const root = mkdtempSync(join(tmpdir(), 'pinpawo-eval-profiles-'));
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({
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
      },
    },
  }), 'utf8');
  return { root, configPath };
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
