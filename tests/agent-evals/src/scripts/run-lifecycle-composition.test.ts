import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  PromptEvalModelMetadata,
  PromptEvalRevision,
} from '../prompt-eval-report.ts';
import {
  createLifecycleCompositionReport,
  LIFECYCLE_COMPOSITION_REPORT_VERSION,
} from './run-lifecycle-composition.eval.ts';

function metadata(
  role: 'subject' | 'judge',
  profileId: string,
): PromptEvalModelMetadata {
  return {
    role,
    profileId,
    fingerprint: `${profileId}-fingerprint`,
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

const revision: PromptEvalRevision = {
  commit: 'candidate',
  harnessCommit: 'harness',
  dirty: false,
  workingTreeDiffSha256: null,
  changedPaths: [],
};

test('lifecycle report V2 records independent subject and judge profiles', () => {
  const report = createLifecycleCompositionReport({
    revision,
    model: metadata('subject', 'subject'),
    structuredOutputMethod: 'not-applicable',
    evaluator: {
      version: 'prompt-goal-v1',
      model: metadata('judge', 'judge'),
      structuredOutputMethod: 'jsonSchema',
    },
    selection: {
      dataset: 'test',
      cases: [],
      repeats: 1,
    },
    results: [],
    summaries: [],
    usage: {
      subject: null,
      evaluator: null,
      estimatedCostUsd: null,
    },
  });

  assert.equal(report.reportVersion, LIFECYCLE_COMPOSITION_REPORT_VERSION);
  assert.equal(report.reportVersion, 2);
  assert.equal(report.model.role, 'subject');
  assert.equal(report.model.profileId, 'subject');
  assert.equal(report.evaluator.model.role, 'judge');
  assert.equal(report.evaluator.model.profileId, 'judge');
  assert.equal('baseUrl' in report.model, false);
  assert.equal('apiKey' in report.model, false);
});
