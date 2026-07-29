import type {
  PromptEvalModelMetadata,
  PromptEvalReport,
} from './prompt-eval-report.ts';
import type { ProviderTokenUsage } from '../src/agent/tokenUsage.ts';

export const PROMPT_EVAL_MATRIX_VERSION = 1 as const;

export type PromptEvalModalityResult =
  | {
      status: 'passed' | 'failed';
      modality: 'image';
      durationMs: number;
      output: string;
      error: string | null;
      usage: ProviderTokenUsage | null;
      estimatedCostUsd: number | null;
    }
  | {
      status: 'skipped';
      modality: 'image';
      reason: 'unsupported-modality';
    };

export type PromptEvalMatrixChild = {
  subject: PromptEvalModelMetadata;
  reportPath: string;
  promptReport: PromptEvalReport;
  imageUnderstanding: PromptEvalModalityResult;
};

export type PromptEvalMatrixManifest = {
  matrixVersion: typeof PROMPT_EVAL_MATRIX_VERSION;
  kind: 'prompt-eval-matrix';
  createdAt: string;
  revision: PromptEvalReport['revision'];
  judge: PromptEvalModelMetadata;
  selection: {
    subjectProfileIds: string[];
    judgeProfileId: string;
    sequential: true;
  };
  budget: {
    maxRuns: number;
    plannedRuns: number;
    maxEstimatedCostUsd: number | null;
  };
  children: Array<{
    subject: PromptEvalModelMetadata;
    reportPath: string;
    imageUnderstanding: PromptEvalModalityResult;
    totals: PromptEvalReport['totals'];
    meanDurationMs: number;
    passRate: number;
    costCovered: boolean;
  }>;
  totals: {
    profiles: number;
    runs: number;
    goalsAchieved: number;
    passRate: number;
    meanDurationMs: number;
    schemaFailures: number;
    invokeFailures: number;
    evaluationFailures: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    subjectTotalTokens: number;
    judgeTotalTokens: number;
    estimatedCostUsd: number | null;
    profilesWithCostCoverage: number;
    imagePassed: number;
    imageFailed: number;
    imageSkippedUnsupported: number;
  };
};

function assertFixedJudge(
  child: PromptEvalMatrixChild,
  expectedJudge: PromptEvalModelMetadata,
) {
  if (child.subject.fingerprint === expectedJudge.fingerprint) {
    throw new Error(
      `Child subject "${child.subject.profileId}" resolves to the fixed judge fingerprint.`,
    );
  }
  const evaluator = child.promptReport.evaluator;
  if (
    evaluator.mode !== 'fixed-model'
    || evaluator.model?.role !== 'judge'
    || evaluator.model.profileId !== expectedJudge.profileId
    || evaluator.model.fingerprint !== expectedJudge.fingerprint
  ) {
    throw new Error(
      `Child report for "${child.subject.profileId}" does not use the fixed judge `
      + `"${expectedJudge.profileId}".`,
    );
  }
}

export function createPromptEvalMatrixManifest(input: {
  children: PromptEvalMatrixChild[];
  judge: PromptEvalModelMetadata;
  maxRuns: number;
  plannedRuns: number;
  maxEstimatedCostUsd: number | null;
}): PromptEvalMatrixManifest {
  if (input.children.length === 0) {
    throw new Error('A prompt eval matrix requires at least one child report.');
  }
  if (input.judge.role !== 'judge') {
    throw new Error('The matrix judge metadata must have role "judge".');
  }
  const first = input.children[0]!;
  const revision = first.promptReport.revision;
  const profileIds = new Set<string>();
  for (const child of input.children) {
    if (child.subject.role !== 'subject') {
      throw new Error('Matrix child metadata must have role "subject".');
    }
    if (profileIds.has(child.subject.profileId)) {
      throw new Error(`Duplicate matrix subject profile "${child.subject.profileId}".`);
    }
    profileIds.add(child.subject.profileId);
    if (
      child.promptReport.model.profileId !== child.subject.profileId
      || child.promptReport.model.fingerprint !== child.subject.fingerprint
    ) {
      throw new Error(
        `Child report subject identity does not match "${child.subject.profileId}".`,
      );
    }
    if (child.promptReport.revision.harnessCommit !== revision.harnessCommit) {
      throw new Error('Matrix child reports use different harness revisions.');
    }
    if (child.promptReport.revision.commit !== revision.commit) {
      throw new Error('Matrix child reports test different revisions.');
    }
    assertFixedJudge(child, input.judge);
  }

  const childRows = input.children.map((child) => {
    const totals = child.promptReport.totals;
    const durationTotal = child.promptReport.results.reduce(
      (sum, result) => sum + result.durationMs,
      0,
    );
    const allCostsCovered = totals.estimatedCostUsd !== null
      && (
        totals.evaluationUsageRuns === 0
        || totals.evaluationEstimatedCostUsd !== null
      )
      && (
        child.imageUnderstanding.status === 'skipped'
        || child.imageUnderstanding.estimatedCostUsd !== null
      );
    return {
      subject: child.subject,
      reportPath: child.reportPath,
      imageUnderstanding: child.imageUnderstanding,
      totals,
      meanDurationMs: totals.runs === 0
        ? 0
        : Math.round(durationTotal / totals.runs),
      passRate: totals.runs === 0 ? 0 : totals.goalsAchieved / totals.runs,
      costCovered: allCostsCovered,
    };
  });
  const runs = childRows.reduce((sum, child) => sum + child.totals.runs, 0);
  const goalsAchieved = childRows.reduce(
    (sum, child) => sum + child.totals.goalsAchieved,
    0,
  );
  const costs = childRows.flatMap((child) => {
    if (!child.costCovered || child.totals.estimatedCostUsd === null) return [];
    return [
      child.totals.estimatedCostUsd
      + (child.totals.evaluationEstimatedCostUsd ?? 0)
      + (
        child.imageUnderstanding.status === 'skipped'
          ? 0
          : child.imageUnderstanding.estimatedCostUsd ?? 0
      ),
    ];
  });
  return {
    matrixVersion: PROMPT_EVAL_MATRIX_VERSION,
    kind: 'prompt-eval-matrix',
    createdAt: new Date().toISOString(),
    revision,
    judge: input.judge,
    selection: {
      subjectProfileIds: childRows.map(({ subject }) => subject.profileId),
      judgeProfileId: input.judge.profileId,
      sequential: true,
    },
    budget: {
      maxRuns: input.maxRuns,
      plannedRuns: input.plannedRuns,
      maxEstimatedCostUsd: input.maxEstimatedCostUsd,
    },
    children: childRows,
    totals: {
      profiles: childRows.length,
      runs,
      goalsAchieved,
      passRate: runs === 0 ? 0 : goalsAchieved / runs,
      meanDurationMs: runs === 0
        ? 0
        : Math.round(input.children.reduce(
            (sum, child) => sum + child.promptReport.results.reduce(
              (childSum, result) => childSum + result.durationMs,
              0,
            ),
            0,
          ) / runs),
      schemaFailures: childRows.reduce(
        (sum, child) => sum + child.totals.schemaFailures,
        0,
      ),
      invokeFailures: childRows.reduce(
        (sum, child) => sum + child.totals.invokeFailures,
        0,
      ),
      evaluationFailures: childRows.reduce(
        (sum, child) => sum + child.totals.evaluationFailures,
        0,
      ),
      inputTokens: childRows.reduce(
        (sum, child) => sum + child.totals.inputTokens
          + child.totals.evaluationInputTokens
          + (child.imageUnderstanding.status === 'skipped'
            ? 0
            : child.imageUnderstanding.usage?.inputTokens ?? 0),
        0,
      ),
      outputTokens: childRows.reduce(
        (sum, child) => sum + child.totals.outputTokens
          + child.totals.evaluationOutputTokens
          + (child.imageUnderstanding.status === 'skipped'
            ? 0
            : child.imageUnderstanding.usage?.outputTokens ?? 0),
        0,
      ),
      totalTokens: childRows.reduce(
        (sum, child) => sum + child.totals.totalTokens
          + child.totals.evaluationTotalTokens
          + (child.imageUnderstanding.status === 'skipped'
            ? 0
            : child.imageUnderstanding.usage?.totalTokens ?? 0),
        0,
      ),
      subjectTotalTokens: childRows.reduce(
        (sum, child) => sum + child.totals.totalTokens
          + (child.imageUnderstanding.status === 'skipped'
            ? 0
            : child.imageUnderstanding.usage?.totalTokens ?? 0),
        0,
      ),
      judgeTotalTokens: childRows.reduce(
        (sum, child) => sum + child.totals.evaluationTotalTokens,
        0,
      ),
      estimatedCostUsd: costs.length === childRows.length
        ? Number(costs.reduce((sum, cost) => sum + cost, 0).toFixed(8))
        : null,
      profilesWithCostCoverage: childRows.filter(({ costCovered }) => costCovered).length,
      imagePassed: childRows.filter(
        ({ imageUnderstanding }) => imageUnderstanding.status === 'passed',
      ).length,
      imageFailed: childRows.filter(
        ({ imageUnderstanding }) => imageUnderstanding.status === 'failed',
      ).length,
      imageSkippedUnsupported: childRows.filter(
        ({ imageUnderstanding }) => imageUnderstanding.status === 'skipped',
      ).length,
    },
  };
}
