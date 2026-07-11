import type { DecisionEvalTarget } from './decision-eval-scenarios.ts';

export type DecisionStabilityResult = {
  target: DecisionEvalTarget;
  caseId: string;
  repeat: number;
  ok: boolean;
  durationMs: number;
  verdict: string | null;
  outputShape: string | null;
  outputFingerprint: string | null;
  failedScores: string[];
  failureKind: 'schema' | 'invoke' | null;
  error: string | null;
};

export type DecisionStabilitySummary = {
  target: DecisionEvalTarget;
  caseId: string;
  runs: number;
  passed: number;
  schemaFailures: number;
  invokeFailures: number;
  outputVariants: number;
  meanDurationMs: number;
  verdictDistribution: Record<string, number>;
  outputShapeDistribution: Record<string, number>;
  failedScoreDistribution: Record<string, number>;
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
  return [...groups.values()].map((group) => ({
    target: group[0].target,
    caseId: group[0].caseId,
    runs: group.length,
    passed: group.filter(({ ok }) => ok).length,
    schemaFailures: group.filter(({ failureKind }) => failureKind === 'schema').length,
    invokeFailures: group.filter(({ failureKind }) => failureKind === 'invoke').length,
    outputVariants: new Set(group.flatMap(({ outputFingerprint }) => outputFingerprint ? [outputFingerprint] : [])).size,
    meanDurationMs: Math.round(group.reduce((sum, { durationMs }) => sum + durationMs, 0) / group.length),
    verdictDistribution: distribution(group.map(({ verdict }) => verdict ?? 'error')),
    outputShapeDistribution: distribution(group.map(({ outputShape }) => outputShape ?? 'error')),
    failedScoreDistribution: distribution(group.flatMap(({ failedScores }) => failedScores)),
  }));
}

export function formatDistribution(values: Record<string, number>): string {
  return Object.entries(values).map(([key, count]) => `${key}:${count.toString()}`).join(', ');
}
