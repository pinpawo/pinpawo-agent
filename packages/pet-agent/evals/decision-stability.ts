import type { ProviderTokenUsage } from '../src/agent/tokenUsage.ts';
import type { DecisionContractScore } from './decision-contract-scorers.ts';
import type { DecisionEvalTarget } from './decision-eval-scenarios.ts';

export type PromptEvalTarget = DecisionEvalTarget | 'answer';

export type DecisionStabilityResult = {
  target: PromptEvalTarget;
  caseId: string;
  contract: string;
  objective: string;
  repeat: number;
  goalAchieved: boolean | null;
  durationMs: number;
  verdict: string | null;
  outputShape: string | null;
  outputFingerprint: string | null;
  criteria: DecisionContractScore[];
  failedCriteria: string[];
  diagnostics: Record<string, unknown>;
  failureKind: 'schema' | 'invoke' | 'evaluation' | null;
  error: string | null;
  usage: ProviderTokenUsage | null;
  estimatedCostUsd: number | null;
  evaluationUsage: ProviderTokenUsage | null;
  evaluationEstimatedCostUsd: number | null;
};

export type DecisionStabilitySummary = {
  target: PromptEvalTarget;
  caseId: string;
  runs: number;
  goalsAchieved: number;
  goalsNotAchieved: number;
  goalsNotEvaluable: number;
  schemaFailures: number;
  invokeFailures: number;
  evaluationFailures: number;
  outputVariants: number;
  meanDurationMs: number;
  verdictDistribution: Record<string, number>;
  outputShapeDistribution: Record<string, number>;
  failedCriterionDistribution: Record<string, number>;
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

function distribution(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

export function summarizeDecisionStability(
  results: DecisionStabilityResult[],
): DecisionStabilitySummary[] {
  const groups = new Map<string, DecisionStabilityResult[]>();
  for (const result of results) {
    const key = `${result.target}:${result.caseId}`;
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  return [...groups.values()].map((group) => {
    const usages = group.flatMap(({ usage }) => usage ? [usage] : []);
    const evaluationUsages = group.flatMap(({ evaluationUsage }) => (
      evaluationUsage ? [evaluationUsage] : []
    ));
    const costs = group.flatMap(({ estimatedCostUsd }) => (
      estimatedCostUsd === null ? [] : [estimatedCostUsd]
    ));
    const evaluationCosts = group.flatMap(({ evaluationEstimatedCostUsd }) => (
      evaluationEstimatedCostUsd === null ? [] : [evaluationEstimatedCostUsd]
    ));
    return {
      target: group[0].target,
      caseId: group[0].caseId,
      runs: group.length,
      goalsAchieved: group.filter(({ goalAchieved }) => goalAchieved === true).length,
      goalsNotAchieved: group.filter(({ goalAchieved }) => goalAchieved === false).length,
      goalsNotEvaluable: group.filter(({ goalAchieved }) => goalAchieved === null).length,
      schemaFailures: group.filter(({ failureKind }) => failureKind === 'schema').length,
      invokeFailures: group.filter(({ failureKind }) => failureKind === 'invoke').length,
      evaluationFailures: group.filter(({ failureKind }) => failureKind === 'evaluation').length,
      outputVariants: new Set(group.flatMap(({ outputFingerprint }) => outputFingerprint ? [outputFingerprint] : [])).size,
      meanDurationMs: Math.round(group.reduce((sum, { durationMs }) => sum + durationMs, 0) / group.length),
      verdictDistribution: distribution(group.map(({ verdict }) => verdict ?? 'error')),
      outputShapeDistribution: distribution(group.map(({ outputShape }) => outputShape ?? 'error')),
      failedCriterionDistribution: distribution(group.flatMap(({ failedCriteria }) => failedCriteria)),
      usageRuns: usages.length,
      inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
      outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
      totalTokens: usages.reduce((sum, usage) => sum + usage.totalTokens, 0),
      estimatedCostUsd: costs.length === group.length
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
    };
  });
}

export function formatDistribution(values: Record<string, number>): string {
  return Object.entries(values).map(([key, count]) => `${key}:${count.toString()}`).join(', ');
}
