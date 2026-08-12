import assert from 'node:assert/strict';
import test from 'node:test';
import {
  comparePromptEvalReports,
  createPromptEvalReport,
  type PromptEvalReport,
} from './prompt-eval-report.ts';

function report(input: { commit: string; passed: boolean; meanDurationMs: number }): PromptEvalReport {
  const result = {
    target: 'goal_creation' as const,
    caseId: 'case-1',
    contract: 'goal_creation.text',
    objective: 'Select answer from sufficient evidence.',
    repeat: 1,
    goalAchieved: input.passed,
    durationMs: input.meanDurationMs,
    verdict: 'answer',
    outputShape: 'action=answer',
    outputFingerprint: '{}',
    criteria: [{
      key: 'entry_mode_correct',
      statement: 'Select answer from sufficient evidence.',
      evaluator: 'deterministic' as const,
      score: input.passed ? 1 as const : 0 as const,
      comment: 'expected answer',
    }],
    failedCriteria: input.passed ? [] : ['entry_mode_correct'],
    diagnostics: {},
    failureKind: null,
    error: null,
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    estimatedCostUsd: 0.001,
    evaluationUsage: null,
    evaluationEstimatedCostUsd: null,
  };
  return createPromptEvalReport({
    revision: {
      commit: input.commit,
      harnessCommit: 'harness',
      dirty: false,
      workingTreeDiffSha256: null,
      changedPaths: [],
    },
    model: {
      role: 'subject',
      profileId: 'subject',
      fingerprint: 'subject-fingerprint',
      provider: 'test',
      family: 'test-family',
      model: 'test-model',
      endpointOrigin: 'https://example.test',
      contextWindowTokens: 32_000,
      maxOutputTokens: null,
      temperature: 0,
      reasoningEffort: 'low',
      timeoutMs: 1000,
      inputModalities: ['text'],
    },
    structuredOutputMethod: 'jsonSchema',
    evaluator: {
      mode: 'not-applicable',
      version: 'not-applicable',
      model: null,
      structuredOutputMethod: 'not-applicable',
    },
    pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 },
    selection: { targets: ['goal_creation'], caseIds: ['case-1'], datasets: ['dataset'], repeats: 1 },
    results: [result],
    summaries: [{
      target: 'goal_creation',
      caseId: 'case-1',
      runs: 1,
      goalsAchieved: input.passed ? 1 : 0,
      goalsNotAchieved: input.passed ? 0 : 1,
      goalsNotEvaluable: 0,
      schemaFailures: 0,
      invokeFailures: 0,
      evaluationFailures: 0,
      outputVariants: 1,
      meanDurationMs: input.meanDurationMs,
      verdictDistribution: { answer: 1 },
      outputShapeDistribution: { 'action=answer': 1 },
      failedCriterionDistribution: input.passed ? {} : { entry_mode_correct: 1 },
      usageRuns: 1,
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      estimatedCostUsd: 0.001,
      evaluationUsageRuns: 0,
      evaluationInputTokens: 0,
      evaluationOutputTokens: 0,
      evaluationTotalTokens: 0,
      evaluationEstimatedCostUsd: null,
    }],
  });
}

test('report totals preserve usage and cost coverage', () => {
  const value = report({ commit: 'baseline', passed: true, meanDurationMs: 20 });
  assert.equal(value.reportVersion, 4);
  assert.deepEqual(value.totals, {
    runs: 1,
    goalsAchieved: 1,
    goalsNotAchieved: 0,
    goalsNotEvaluable: 0,
    schemaFailures: 0,
    invokeFailures: 0,
    evaluationFailures: 0,
    usageRuns: 1,
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 12,
    estimatedCostUsd: 0.001,
    evaluationUsageRuns: 0,
    evaluationInputTokens: 0,
    evaluationOutputTokens: 0,
    evaluationTotalTokens: 0,
    evaluationEstimatedCostUsd: null,
  });
});

test('comparison reports pass, latency, and token deltas for matching cases', () => {
  const comparison = comparePromptEvalReports(
    report({ commit: 'baseline', passed: false, meanDurationMs: 20 }),
    report({ commit: 'candidate', passed: true, meanDurationMs: 25 }),
  );
  assert.equal(comparison.compatible, true);
  assert.equal(comparison.rows[0].passRateDelta, 1);
  assert.equal(comparison.rows[0].meanDurationDeltaMs, 5);
  assert.equal(comparison.rows[0].meanTokensDelta, 0);
});

test('comparison rejects different harness revisions', () => {
  const baseline = report({ commit: 'baseline', passed: true, meanDurationMs: 20 });
  const candidate = report({ commit: 'candidate', passed: true, meanDurationMs: 20 });
  candidate.revision.harnessCommit = 'different-harness';
  const comparison = comparePromptEvalReports(baseline, candidate);
  assert.equal(comparison.compatible, false);
  assert.ok(comparison.compatibilityNotes.includes('harness commit differs'));
});

test('comparison rejects different evaluator settings', () => {
  const baseline = report({ commit: 'baseline', passed: true, meanDurationMs: 20 });
  const candidate = report({ commit: 'candidate', passed: true, meanDurationMs: 20 });
  candidate.evaluator = {
    mode: 'fixed-model',
    version: 'prompt-goal-v1',
    model: {
      ...candidate.model,
      role: 'judge',
      profileId: 'judge',
      fingerprint: 'judge-fingerprint',
    },
    structuredOutputMethod: 'jsonSchema',
  };
  const comparison = comparePromptEvalReports(baseline, candidate);
  assert.equal(comparison.compatible, false);
  assert.ok(comparison.compatibilityNotes.includes('evaluator mode differs'));
});

test('comparison rejects a different subject fingerprint', () => {
  const baseline = report({ commit: 'baseline', passed: true, meanDurationMs: 20 });
  const candidate = report({ commit: 'candidate', passed: true, meanDurationMs: 20 });
  candidate.model.fingerprint = 'another-endpoint';
  const comparison = comparePromptEvalReports(baseline, candidate);
  assert.equal(comparison.compatible, false);
  assert.ok(
    comparison.compatibilityNotes.includes('subject fingerprint differs'),
  );
});
