import assert from 'node:assert/strict';
import test from 'node:test';
import type { PromptEvalModelMetadata, PromptEvalReport } from './prompt-eval-report.ts';
import {
  assertPromptEvalMatrixPricing,
  createPromptEvalMatrixManifest,
} from './prompt-eval-matrix.ts';

function metadata(
  role: 'subject' | 'judge',
  profileId: string,
  fingerprint = `${profileId}-fingerprint`,
): PromptEvalModelMetadata {
  return {
    role,
    profileId,
    fingerprint,
    provider: 'test',
    family: 'test',
    model: profileId,
    endpointOrigin: `https://${profileId}.example.test`,
    contextWindowTokens: 32_000,
    maxOutputTokens: null,
    temperature: 0,
    reasoningEffort: 'provider-default',
    timeoutMs: 1000,
    inputModalities: ['text'],
  };
}

function report(
  subject: PromptEvalModelMetadata,
  judge: PromptEvalModelMetadata,
): PromptEvalReport {
  return {
    reportVersion: 4,
    kind: 'prompt-stability',
    createdAt: '2026-01-01T00:00:00.000Z',
    revision: {
      commit: 'candidate',
      harnessCommit: 'harness',
      dirty: false,
      workingTreeDiffSha256: null,
      changedPaths: [],
    },
    model: subject,
    structuredOutputMethod: 'jsonSchema',
    evaluator: {
      mode: 'fixed-model',
      version: 'prompt-goal-v1',
      model: judge,
      structuredOutputMethod: 'jsonSchema',
    },
    pricing: null,
    selection: {
      targets: ['goal_creation'],
      caseIds: ['case'],
      datasets: ['dataset'],
      repeats: 1,
    },
    results: [{
      target: 'goal_creation',
      caseId: 'case',
      contract: 'entry',
      objective: 'choose',
      repeat: 1,
      goalAchieved: true,
      durationMs: 10,
      verdict: 'answer',
      outputShape: 'answer',
      outputFingerprint: '{}',
      criteria: [],
      failedCriteria: [],
      diagnostics: {},
      failureKind: null,
      error: null,
      usage: null,
      estimatedCostUsd: null,
      evaluationUsage: null,
      evaluationEstimatedCostUsd: null,
    }],
    summaries: [],
    totals: {
      runs: 1,
      goalsAchieved: 1,
      goalsNotAchieved: 0,
      goalsNotEvaluable: 0,
      schemaFailures: 0,
      invokeFailures: 0,
      evaluationFailures: 0,
      usageRuns: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: null,
      evaluationUsageRuns: 0,
      evaluationInputTokens: 0,
      evaluationOutputTokens: 0,
      evaluationTotalTokens: 0,
      evaluationEstimatedCostUsd: null,
    },
  };
}

test('matrix manifest groups child reports by stable subject profile', () => {
  const judge = metadata('judge', 'judge');
  const first = metadata('subject', 'first');
  const second = metadata('subject', 'second');
  const manifest = createPromptEvalMatrixManifest({
    judge,
    maxRuns: 10,
    plannedRuns: 4,
    maxEstimatedCostUsd: null,
    children: [
      {
        subject: first,
        reportPath: 'first.json',
        promptReport: report(first, judge),
        imageUnderstanding: {
          status: 'skipped',
          modality: 'image',
          reason: 'unsupported-modality',
        },
      },
      {
        subject: second,
        reportPath: 'second.json',
        promptReport: report(second, judge),
        imageUnderstanding: {
          status: 'passed',
          modality: 'image',
          durationMs: 20,
          output: 'RED',
          error: null,
          usage: null,
          estimatedCostUsd: null,
        },
      },
    ],
  });

  assert.deepEqual(manifest.selection.subjectProfileIds, ['first', 'second']);
  assert.equal(manifest.totals.profiles, 2);
  assert.equal(manifest.totals.passRate, 1);
  assert.equal(manifest.totals.imagePassed, 1);
  assert.equal(manifest.totals.imageSkippedUnsupported, 1);
});

test('matrix manifest rejects a child attributed to another judge', () => {
  const judge = metadata('judge', 'judge');
  const subject = metadata('subject', 'subject');
  assert.throws(
    () => createPromptEvalMatrixManifest({
      judge,
      maxRuns: 10,
      plannedRuns: 1,
      maxEstimatedCostUsd: null,
      children: [{
        subject,
        reportPath: 'subject.json',
        promptReport: report(subject, metadata('judge', 'other-judge')),
        imageUnderstanding: {
          status: 'skipped',
          modality: 'image',
          reason: 'unsupported-modality',
        },
      }],
    }),
    /does not use the fixed judge/,
  );
});

test('matrix manifest rejects mixed harness revisions', () => {
  const judge = metadata('judge', 'judge');
  const first = metadata('subject', 'first');
  const second = metadata('subject', 'second');
  const secondReport = report(second, judge);
  secondReport.revision.harnessCommit = 'another-harness';
  assert.throws(
    () => createPromptEvalMatrixManifest({
      judge,
      maxRuns: 10,
      plannedRuns: 2,
      maxEstimatedCostUsd: null,
      children: [
        {
          subject: first,
          reportPath: 'first.json',
          promptReport: report(first, judge),
          imageUnderstanding: {
            status: 'skipped',
            modality: 'image',
            reason: 'unsupported-modality',
          },
        },
        {
          subject: second,
          reportPath: 'second.json',
          promptReport: secondReport,
          imageUnderstanding: {
            status: 'skipped',
            modality: 'image',
            reason: 'unsupported-modality',
          },
        },
      ],
    }),
    /different harness revisions/,
  );
});

test('matrix manifest rejects a subject that resolves to the judge fingerprint', () => {
  const judge = metadata('judge', 'judge');
  const subject = metadata('subject', 'subject', judge.fingerprint);
  assert.throws(
    () => createPromptEvalMatrixManifest({
      judge,
      maxRuns: 10,
      plannedRuns: 1,
      maxEstimatedCostUsd: null,
      children: [{
        subject,
        reportPath: 'subject.json',
        promptReport: report(subject, judge),
        imageUnderstanding: {
          status: 'skipped',
          modality: 'image',
          reason: 'unsupported-modality',
        },
      }],
    }),
    /resolves to the fixed judge fingerprint/,
  );
});

test('matrix pricing preflight rejects every unpriced profile before execution', () => {
  assert.throws(
    () => assertPromptEvalMatrixPricing({
      judge: {
        profileId: 'judge',
        pricing: null,
      },
      subjects: [
        {
          profileId: 'priced-subject',
          pricing: {
            inputUsdPerMillionTokens: 1,
            outputUsdPerMillionTokens: 2,
          },
        },
        {
          profileId: 'unpriced-subject',
          pricing: null,
        },
      ],
    }),
    /judge, unpriced-subject/,
  );
});

test('matrix pricing preflight accepts complete subject and judge pricing', () => {
  const pricing = {
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 2,
  };
  assert.doesNotThrow(() => assertPromptEvalMatrixPricing({
    judge: {
      profileId: 'judge',
      pricing,
    },
    subjects: [{
      profileId: 'subject',
      pricing,
    }],
  }));
});
