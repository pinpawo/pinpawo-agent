import type { StructuredOutputMethod } from '../src/utils/structuredOutput.ts';
import type {
  DecisionStabilityResult,
  DecisionStabilitySummary,
  PromptEvalTarget,
} from './decision-stability.ts';
import type { PromptEvalPricing } from './prompt-eval-usage.ts';

export const PROMPT_EVAL_REPORT_VERSION = 3;

export type PromptEvalRevision = {
  commit: string;
  harnessCommit: string;
  dirty: boolean;
  workingTreeDiffSha256: string | null;
  changedPaths: string[];
};

export type PromptEvalModelMetadata = {
  provider: string;
  family: string;
  model: string;
  baseUrl: string;
  temperature: number;
  reasoningEffort: string;
  timeoutMs: number;
};

export type PromptEvalReport = {
  reportVersion: typeof PROMPT_EVAL_REPORT_VERSION;
  kind: 'prompt-stability';
  createdAt: string;
  revision: PromptEvalRevision;
  model: PromptEvalModelMetadata;
  structuredOutputMethod: StructuredOutputMethod | 'provider-default' | 'not-applicable';
  evaluator: {
    mode: 'subject-model' | 'not-applicable';
    version: 'answer-goal-v1' | 'not-applicable';
    model: PromptEvalModelMetadata | null;
    structuredOutputMethod: StructuredOutputMethod | 'provider-default' | 'not-applicable';
  };
  pricing: PromptEvalPricing | null;
  selection: {
    targets: PromptEvalTarget[];
    caseIds: string[];
    datasets: string[];
    repeats: number;
  };
  results: DecisionStabilityResult[];
  summaries: DecisionStabilitySummary[];
  totals: {
    runs: number;
    goalsAchieved: number;
    goalsNotAchieved: number;
    goalsNotEvaluable: number;
    schemaFailures: number;
    invokeFailures: number;
    evaluationFailures: number;
    usageRuns: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number | null;
    evaluationUsageRuns: number;
    evaluationInputTokens: number;
    evaluationOutputTokens: number;
    evaluationTotalTokens: number;
    evaluationEstimatedCostUsd: number | null;
  };
};

export function createPromptEvalReport(input: Omit<
  PromptEvalReport,
  'reportVersion' | 'kind' | 'createdAt' | 'totals'
>): PromptEvalReport {
  const usages = input.results.flatMap(({ usage }) => usage ? [usage] : []);
  const evaluationUsages = input.results.flatMap(({ evaluationUsage }) => (
    evaluationUsage ? [evaluationUsage] : []
  ));
  const costs = input.results.flatMap(({ estimatedCostUsd }) => (
    estimatedCostUsd === null ? [] : [estimatedCostUsd]
  ));
  const evaluationCosts = input.results.flatMap(({ evaluationEstimatedCostUsd }) => (
    evaluationEstimatedCostUsd === null ? [] : [evaluationEstimatedCostUsd]
  ));
  return {
    reportVersion: PROMPT_EVAL_REPORT_VERSION,
    kind: 'prompt-stability',
    createdAt: new Date().toISOString(),
    ...input,
    totals: {
      runs: input.results.length,
      goalsAchieved: input.results.filter(({ goalAchieved }) => goalAchieved === true).length,
      goalsNotAchieved: input.results.filter(({ goalAchieved }) => goalAchieved === false).length,
      goalsNotEvaluable: input.results.filter(({ goalAchieved }) => goalAchieved === null).length,
      schemaFailures: input.results.filter(({ failureKind }) => failureKind === 'schema').length,
      invokeFailures: input.results.filter(({ failureKind }) => failureKind === 'invoke').length,
      evaluationFailures: input.results.filter(({ failureKind }) => failureKind === 'evaluation').length,
      usageRuns: usages.length,
      inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
      outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
      totalTokens: usages.reduce((sum, usage) => sum + usage.totalTokens, 0),
      estimatedCostUsd: costs.length === input.results.length
        ? Number(costs.reduce((sum, cost) => sum + cost, 0).toFixed(8))
        : null,
      evaluationUsageRuns: evaluationUsages.length,
      evaluationInputTokens: evaluationUsages.reduce((sum, usage) => sum + usage.inputTokens, 0),
      evaluationOutputTokens: evaluationUsages.reduce((sum, usage) => sum + usage.outputTokens, 0),
      evaluationTotalTokens: evaluationUsages.reduce((sum, usage) => sum + usage.totalTokens, 0),
      evaluationEstimatedCostUsd: evaluationUsages.length > 0
        && evaluationCosts.length === evaluationUsages.length
        ? Number(evaluationCosts.reduce((sum, cost) => sum + cost, 0).toFixed(8))
        : null,
    },
  };
}

export type PromptEvalComparisonRow = {
  target: PromptEvalTarget;
  caseId: string;
  baselinePassRate: number;
  candidatePassRate: number;
  passRateDelta: number;
  meanDurationDeltaMs: number;
  meanTokensDelta: number | null;
};

export type PromptEvalComparison = {
  compatible: boolean;
  compatibilityNotes: string[];
  baselineOnlyCases: string[];
  candidateOnlyCases: string[];
  rows: PromptEvalComparisonRow[];
};

function summaryKey(summary: DecisionStabilitySummary): string {
  return `${summary.target}:${summary.caseId}`;
}

export function comparePromptEvalReports(
  baseline: PromptEvalReport,
  candidate: PromptEvalReport,
): PromptEvalComparison {
  const notes: string[] = [];
  const blockingNotes: string[] = [];
  if (baseline.revision.harnessCommit !== candidate.revision.harnessCommit) {
    blockingNotes.push('harness commit differs');
  }
  if (baseline.model.provider !== candidate.model.provider) blockingNotes.push('provider differs');
  if (baseline.model.model !== candidate.model.model) blockingNotes.push('model differs');
  if (baseline.model.baseUrl !== candidate.model.baseUrl) blockingNotes.push('base URL differs');
  if (baseline.model.reasoningEffort !== candidate.model.reasoningEffort) {
    blockingNotes.push('reasoning effort differs');
  }
  if (baseline.structuredOutputMethod !== candidate.structuredOutputMethod) {
    blockingNotes.push('structured output method differs');
  }
  if (baseline.evaluator.mode !== candidate.evaluator.mode) blockingNotes.push('evaluator mode differs');
  if (baseline.evaluator.version !== candidate.evaluator.version) {
    blockingNotes.push('evaluator version differs');
  }
  if (baseline.evaluator.model?.provider !== candidate.evaluator.model?.provider
    || baseline.evaluator.model?.model !== candidate.evaluator.model?.model
    || baseline.evaluator.model?.baseUrl !== candidate.evaluator.model?.baseUrl
    || baseline.evaluator.model?.temperature !== candidate.evaluator.model?.temperature
    || baseline.evaluator.model?.reasoningEffort !== candidate.evaluator.model?.reasoningEffort
    || baseline.evaluator.structuredOutputMethod !== candidate.evaluator.structuredOutputMethod) {
    blockingNotes.push('evaluator configuration differs');
  }
  if (baseline.model.temperature !== candidate.model.temperature) blockingNotes.push('temperature differs');
  if (baseline.selection.repeats !== candidate.selection.repeats) notes.push('repeat count differs');
  notes.push(...blockingNotes);
  const baselineByKey = new Map(baseline.summaries.map((summary) => [summaryKey(summary), summary]));
  const candidateByKey = new Map(candidate.summaries.map((summary) => [summaryKey(summary), summary]));
  const baselineOnlyCases = [...baselineByKey.keys()].filter((key) => !candidateByKey.has(key));
  const candidateOnlyCases = [...candidateByKey.keys()].filter((key) => !baselineByKey.has(key));
  if (baselineOnlyCases.length > 0 || candidateOnlyCases.length > 0) notes.push('case coverage differs');

  const rows = [...baselineByKey.entries()].flatMap(([key, baselineSummary]) => {
    const candidateSummary = candidateByKey.get(key);
    if (!candidateSummary) return [];
    const baselinePassRate = baselineSummary.goalsAchieved / baselineSummary.runs;
    const candidatePassRate = candidateSummary.goalsAchieved / candidateSummary.runs;
    const baselineMeanTokens = baselineSummary.usageRuns === baselineSummary.runs
      ? baselineSummary.totalTokens / baselineSummary.runs
      : null;
    const candidateMeanTokens = candidateSummary.usageRuns === candidateSummary.runs
      ? candidateSummary.totalTokens / candidateSummary.runs
      : null;
    return [{
      target: baselineSummary.target,
      caseId: baselineSummary.caseId,
      baselinePassRate,
      candidatePassRate,
      passRateDelta: candidatePassRate - baselinePassRate,
      meanDurationDeltaMs: candidateSummary.meanDurationMs - baselineSummary.meanDurationMs,
      meanTokensDelta: baselineMeanTokens === null || candidateMeanTokens === null
        ? null
        : candidateMeanTokens - baselineMeanTokens,
    }];
  });
  return {
    compatible: blockingNotes.length === 0,
    compatibilityNotes: notes,
    baselineOnlyCases,
    candidateOnlyCases,
    rows,
  };
}
