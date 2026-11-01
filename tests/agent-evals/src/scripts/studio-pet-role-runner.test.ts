import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AIMessage } from '@langchain/core/messages';
import { studioPetRoleCases } from '../datasets/studio-pet-roles.ts';
import type { DecisionContractScore } from '../decision-contract-scorers.ts';
import { StudioPetRoleInvocationError, StudioPetRoleJudgeError } from '../studio-pet-role-evaluation.ts';
import type { DecisionEvalModel } from './decision-eval-model.ts';
import {
  assertDistinctStudioPetEvalModels,
  classifyStudioPetEvalError,
  readStudioPetRoleEvalOptions,
  runStudioPetRoleEval,
  summarizeStudioPetRoleEvalResults,
} from './run-studio-pet-roles.eval.ts';

const profiles = {
  PROMPT_EVAL_MODEL_PROFILE_ID: 'subject',
  PROMPT_EVAL_JUDGE_PROFILE_ID: 'judge',
};

const passingScore: DecisionContractScore = {
  key: 'role_boundary',
  statement: 'Stay within the role boundary.',
  evaluator: 'deterministic',
  score: 1,
  comment: 'Role boundary satisfied.',
};

test('Studio Pet eval defaults to three repeats and caps the run count', () => {
  assert.equal(readStudioPetRoleEvalOptions(profiles, []).repeats, 3);
  assert.equal(readStudioPetRoleEvalOptions({ ...profiles, PROMPT_EVAL_REPEATS: '10' }, []).repeats, 10);
  for (const value of ['0', '-1', '11', '1.5', 'NaN', '', '1e1', '0x3']) {
    assert.throws(() => readStudioPetRoleEvalOptions({ ...profiles, PROMPT_EVAL_REPEATS: value }, []));
  }
  assert.throws(() => readStudioPetRoleEvalOptions(profiles, ['--unknown']));
});

test('baseline and prompt capture are explicit and private announcements cannot enable prompt capture', () => {
  const defaults = readStudioPetRoleEvalOptions(profiles, []);
  assert.equal(defaults.baseline, false);
  assert.equal(defaults.captureSyntheticContent, false);
  const enabled = readStudioPetRoleEvalOptions({ ...profiles,
    STUDIO_PET_EVAL_BASELINE: '1', STUDIO_PET_EVAL_CAPTURE_PROMPTS: '1',
  }, []);
  assert.equal(enabled.baseline, true);
  assert.equal(enabled.captureSyntheticContent, true);
  for (const flag of ['STUDIO_PET_EVAL_BASELINE', 'STUDIO_PET_EVAL_CAPTURE_PROMPTS']) {
    for (const value of ['', 'true', '2']) assert.throws(() => readStudioPetRoleEvalOptions({ ...profiles, [flag]: value }, []));
  }
  assert.throws(() => readStudioPetRoleEvalOptions({ ...profiles,
    STUDIO_PET_EVAL_CAPTURE_PROMPTS: '1', STUDIO_PET_EVAL_CHANNEL_PROMPT_FILE: '/private/announcement.txt',
  }, []), /public synthetic announcement/);
  assert.doesNotThrow(() => readStudioPetRoleEvalOptions({ ...profiles,
    STUDIO_PET_EVAL_CAPTURE_PROMPTS: '0', STUDIO_PET_EVAL_CHANNEL_PROMPT_FILE: '/private/announcement.txt',
  }, []));
});

test('Studio Pet eval validates both profiles only for actual runs', () => {
  assert.throws(() => readStudioPetRoleEvalOptions({}, []), /PROMPT_EVAL_MODEL_PROFILE_ID/);
  assert.throws(() => readStudioPetRoleEvalOptions({ PROMPT_EVAL_MODEL_PROFILE_ID: 'subject' }, []),
    /PROMPT_EVAL_JUDGE_PROFILE_ID/);
  assert.equal(readStudioPetRoleEvalOptions({}, ['--list']).list, true);
});

test('Studio Pet eval selects a case by ID or name and rejects mistyped filters', () => {
  const first = studioPetRoleCases[0]!;
  for (const caseFilter of [first.id, first.name]) {
    const options = readStudioPetRoleEvalOptions({ ...profiles, PROMPT_EVAL_CASE: caseFilter }, []);
    assert.deepEqual(options.cases.map(({ id }) => id), [first.id]);
  }
  const roleOptions = readStudioPetRoleEvalOptions({ ...profiles, STUDIO_PET_EVAL_ROLE: 'reviewer' }, []);
  assert.ok(roleOptions.cases.length > 0);
  assert.ok(roleOptions.cases.every(({ role }) => role === 'reviewer'));
  assert.throws(() => readStudioPetRoleEvalOptions({ ...profiles, PROMPT_EVAL_CASE: 'typo-case' }, []));
  assert.throws(() => readStudioPetRoleEvalOptions({ ...profiles, PROMPT_EVAL_CASE: ' ' }, []));
  assert.throws(() => readStudioPetRoleEvalOptions({ ...profiles, STUDIO_PET_EVAL_ROLE: 'review' }, []));
  assert.throws(() => readStudioPetRoleEvalOptions({
    ...profiles,
    PROMPT_EVAL_CASE: first.id,
    STUDIO_PET_EVAL_ROLE: first.role === 'wiki' ? 'issuer' : 'wiki',
  }, []));
});

test('--list emits case IDs, roles and phases without resolving profiles or invoking models', async () => {
  const lines: string[] = [];
  const exitCode = await runStudioPetRoleEval({ PROMPT_EVAL_CONFIG_PATH: '/missing/config.json' }, ['--list'], {
    createModel: () => { throw new Error('Model configuration must not be read.'); },
    runCase: async () => { throw new Error('A model must not be invoked.'); },
    log: (line) => lines.push(line),
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(lines.map((line) => line.split('\t').slice(0, 3)),
    studioPetRoleCases.map(({ id, role, phase }) => [id, role, phase]));
});

test('resolved fingerprint equality is rejected even when profile aliases differ', () => {
  const subject = { profileId: 'subject-alias', fingerprint: 'same-resolved-model' };
  const judge = { profileId: 'judge-alias', fingerprint: 'same-resolved-model' };
  assert.throws(() => assertDistinctStudioPetEvalModels(subject, judge), /fingerprints/);
  assert.doesNotThrow(() => assertDistinctStudioPetEvalModels(subject, { fingerprint: 'other-model' }));
});

test('profile configuration failures do not expose provider error payloads', async () => {
  await assert.rejects(runStudioPetRoleEval(profiles, [], {
    createModel: () => { throw new Error('secret-provider-configuration'); },
    log: () => {},
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes('secret-provider-configuration'));
    assert.match(error.message, /subject model profile/);
    return true;
  });
});

test('summary keeps errors and missing scores as failures', () => {
  assert.deepEqual(summarizeStudioPetRoleEvalResults([
    { scores: [passingScore], failureKind: null },
    { scores: [{ ...passingScore, score: 0 }], failureKind: null },
    { scores: [], failureKind: null },
    { scores: [], failureKind: 'evaluation' },
    { scores: [], failureKind: 'invoke' },
  ]), { runs: 5, passed: 1, failed: 4, scoreFailures: 2, errors: 2, exitCode: 1 });
  assert.equal(summarizeStudioPetRoleEvalResults([]).exitCode, 1);
  assert.equal(summarizeStudioPetRoleEvalResults([{ scores: [passingScore], failureKind: null }]).exitCode, 0);
  assert.equal(classifyStudioPetEvalError(new DOMException('timeout', 'TimeoutError')), 'timeout');
});

function fakeModel(role: 'subject' | 'judge'): DecisionEvalModel {
  return {
    model: {} as DecisionEvalModel['model'],
    method: 'jsonSchema',
    label: role,
    pricing: null,
    metadata: {
      role,
      profileId: role,
      fingerprint: `${role}-fingerprint`,
      provider: 'openai-compatible',
      family: 'fixture',
      model: 'fixture',
      endpointOrigin: 'https://example.test',
      contextWindowTokens: 32_000,
      maxOutputTokens: null,
      temperature: 0,
      reasoningEffort: 'provider-default',
      timeoutMs: 120_000,
      inputModalities: ['text'],
    },
  };
}

test('runner saves every failed attempt without raw errors and keeps invocation limits', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'studio-pet-runner-'));
  let calls = 0;
  try {
    const exitCode = await runStudioPetRoleEval({
      ...profiles,
      PROMPT_EVAL_CASE: studioPetRoleCases[0]!.id,
      PROMPT_EVAL_OUTPUT_DIR: outputDir,
    }, [], {
      createModel: ({ role }) => fakeModel(role),
      runCase: async ({ config, judge }) => {
        calls += 1;
        assert.equal(config?.recursionLimit, 40);
        assert.ok(config?.signal instanceof AbortSignal);
        assert.equal(config.signal, judge.config?.signal);
        if (calls === 1) throw new Error('private-api-key-and-trace');
        if (calls === 2) throw new StudioPetRoleJudgeError(new Error('private-judge-key'), {
          output: { goal: 'synthetic-goal', briefing: 'synthetic-briefing' },
          scores: [passingScore],
          contextHash: 'judge-failed-context-hash',
          evaluationSummary: null,
        });
        return {
          output: { kind: 'reply' },
          scores: [{ ...passingScore, score: 0 }],
          contextHash: 'synthetic-context-hash',
          evaluationSummary: 'Role acceptance criterion was not met.',
        };
      },
      log: () => {},
    });
    assert.equal(exitCode, 1);
    assert.equal(calls, 3);
    const text = readFileSync(join(outputDir, 'report.json'), 'utf8');
    assert.ok(!text.includes('private-api-key-and-trace'));
    assert.ok(!text.includes('private-judge-key'));
    const report = JSON.parse(text);
    assert.equal(report.reportVersion, 2);
    assert.equal(report.baseline.enabled, false);
    assert.deepEqual(report.baseline.results, []);
    assert.equal(report.complete, true);
    assert.equal(report.summary.failed, 3);
    assert.deepEqual(report.results.map((result: { failureKind: unknown }) => result.failureKind),
      ['invoke', 'evaluation', null]);
    assert.deepEqual(report.results[0].input, studioPetRoleCases[0]);
    assert.deepEqual(report.results[1].output, { goal: 'synthetic-goal', briefing: 'synthetic-briefing' });
    assert.deepEqual(report.results[1].scores, [passingScore]);
    assert.equal(report.results[1].contextHash, 'judge-failed-context-hash');
    assert.equal(report.results[1].evaluationSummary, null);
    assert.equal(report.results[2].contextHash, 'synthetic-context-hash');
    assert.match(report.datasetSha256, /^[a-f0-9]{64}$/);
    assert.match(report.revision.commit, /^[a-f0-9]{40,64}$/);
    assert.equal(typeof report.revision.dirty, 'boolean');
    assert.equal(report.subject.fingerprint, 'subject-fingerprint');
    assert.equal(report.judge.fingerprint, 'judge-fingerprint');
    assert.equal(report.limits.caseTimeoutMs, 180_000);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('optional baseline uses the same subject and limits without a judge or changing role pass rates', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'studio-pet-baseline-'));
  const subject = fakeModel('subject');
  let baselineCalls = 0, roleCalls = 0;
  try {
    const exitCode = await runStudioPetRoleEval({ ...profiles,
      PROMPT_EVAL_CASE: studioPetRoleCases[0]!.id, PROMPT_EVAL_REPEATS: '2', PROMPT_EVAL_OUTPUT_DIR: outputDir,
      STUDIO_PET_EVAL_BASELINE: '1', STUDIO_PET_EVAL_CAPTURE_PROMPTS: '1',
    }, [], {
      createModel: ({ role }) => role === 'subject' ? subject : fakeModel('judge'),
      runBaseline: async (model, method, config, judge) => {
        baselineCalls += 1;
        assert.equal(model, subject.model);
        assert.equal(method, subject.method);
        assert.equal(config?.recursionLimit, 40);
        assert.ok(config?.signal instanceof AbortSignal);
        assert.equal(judge, undefined);
        if (baselineCalls === 1) throw new Error('private-baseline-provider-message');
        return { output: { route: 'plan_request' }, scores: [passingScore], verdict: 'plan_request', shape: 'fixture' };
      },
      runCase: async ({ model, captureSyntheticContent }) => {
        roleCalls += 1;
        assert.equal(model, subject.model);
        assert.equal(captureSyntheticContent, true);
        return { output: { kind: 'reply' }, scores: [passingScore], contextHash: 'context', evaluationSummary: 'Fixture.' };
      },
      log: () => {},
    });
    assert.equal(exitCode, 1, 'an explicitly requested failing baseline is still a failing run');
    assert.equal(baselineCalls, 2);
    assert.equal(roleCalls, 2);
    const text = readFileSync(join(outputDir, 'report.json'), 'utf8');
    assert.ok(!text.includes('private-baseline-provider-message'));
    const report = JSON.parse(text);
    assert.equal(report.baseline.caseName, 'repository-task-enters-supervisor');
    assert.equal(report.baseline.subjectFingerprint, report.subject.fingerprint);
    assert.equal(report.baseline.summary.runs, 2);
    assert.equal(report.baseline.summary.passed, 1);
    assert.equal(report.baseline.summary.errors, 1);
    assert.equal(report.summary.runs, 2);
    assert.equal(report.summary.passed, 2, 'baseline failure is not a role-semantic failure');
    assert.equal(report.captureSyntheticContent, true);
    assert.equal(report.complete, true);
  } finally { rmSync(outputDir, { recursive: true, force: true }); }
});

test('invocation failures retain partial decisions and classify the original error without exposing it', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'studio-pet-invocation-failure-'));
  const partial = { output: { goal: 'Known goal.', modelCalls: [{ stage: 'supervisor-entry' }] },
    scores: [passingScore], contextHash: 'partial-context', evaluationSummary: null };
  try {
    const error = new StudioPetRoleInvocationError(new DOMException('private-provider-timeout-payload', 'TimeoutError'), partial);
    assert.equal(classifyStudioPetEvalError(error), 'timeout');
    const exitCode = await runStudioPetRoleEval({ ...profiles,
      PROMPT_EVAL_CASE: studioPetRoleCases[0]!.id, PROMPT_EVAL_REPEATS: '1', PROMPT_EVAL_OUTPUT_DIR: outputDir,
    }, [], { createModel: ({ role }) => fakeModel(role), runCase: async ({ captureSyntheticContent }) => {
      assert.equal(captureSyntheticContent, false);
      throw error;
    }, log: () => {} });
    assert.equal(exitCode, 1);
    const text = readFileSync(join(outputDir, 'report.json'), 'utf8');
    assert.ok(!text.includes('private-provider-timeout-payload'));
    const report = JSON.parse(text);
    assert.equal(report.results[0].failureKind, 'timeout');
    assert.deepEqual(report.results[0].output, partial.output);
    assert.equal(report.results[0].contextHash, partial.contextHash);
  } finally { rmSync(outputDir, { recursive: true, force: true }); }
});

test('the built-in baseline executes the existing Entry route and schema scorer', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'studio-pet-existing-baseline-'));
  const bound: string[][] = [];
  const subject = fakeModel('subject');
  subject.model = {
    bindTools: (tools: Array<{ name: string }>) => {
      bound.push(tools.map(tool => tool.name));
      return { invoke: async () => new AIMessage({ content: '', tool_calls: [{
        id: 'baseline-plan', type: 'tool_call', name: 'plan_request', args: { goal: 'Repair the repository TypeScript errors and run tests.' },
      }] }) };
    },
  } as never;
  try {
    const exitCode = await runStudioPetRoleEval({ ...profiles,
      PROMPT_EVAL_CASE: studioPetRoleCases[0]!.id, PROMPT_EVAL_REPEATS: '1', PROMPT_EVAL_OUTPUT_DIR: outputDir,
      STUDIO_PET_EVAL_BASELINE: '1',
    }, [], { createModel: ({ role }) => role === 'subject' ? subject : fakeModel('judge'),
      runCase: async () => ({ output: { kind: 'reply' }, scores: [passingScore], contextHash: 'context', evaluationSummary: 'Fixture.' }),
      log: () => {},
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(bound, [['plan_request', 'continue']]);
    const report = JSON.parse(readFileSync(join(outputDir, 'report.json'), 'utf8'));
    assert.equal(report.baseline.results[0].output.route, 'plan_request');
    assert.deepEqual(report.baseline.results[0].scores.map((score: DecisionContractScore) => [score.key, score.evaluator, score.score]),
      [['route_correct', 'deterministic', 1], ['plan_request_shape', 'deterministic', 1]]);
    assert.equal(report.baseline.summary.passed, 1);
  } finally { rmSync(outputDir, { recursive: true, force: true }); }
});
