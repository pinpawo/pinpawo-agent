import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { RunnableConfig } from '@langchain/core/runnables';
import { getAnswerEvalScenarios } from '../answer-eval-scenarios.ts';
import {
  getDecisionEvalScenarios,
  type DecisionEvalRunResult,
} from '../decision-eval-scenarios.ts';
import {
  formatDistribution,
  summarizeDecisionStability,
  type DecisionStabilityResult,
  type PromptEvalTarget,
} from '../decision-stability.ts';
import { createPromptEvalReport, type PromptEvalRevision } from '../prompt-eval-report.ts';
import {
  createPromptEvalUsageCollector,
  estimatePromptEvalCost,
} from '../prompt-eval-usage.ts';
import type { AgentModels } from '../../src/types/agent.ts';
import type { StructuredOutputMethod } from '../../src/utils/structuredOutput.ts';
import { createDecisionEvalModel } from './decision-eval-model.ts';

const TARGETS: PromptEvalTarget[] = ['entry', 'planner', 'capability', 'outcome', 'answer'];
const DEFAULT_REPEATS = 5;

type PromptEvalScenario = {
  target: PromptEvalTarget;
  datasetName: string;
  caseId: string;
  caseName: string;
  run(
    model: AgentModels['act'],
    method: StructuredOutputMethod | undefined,
    config: RunnableConfig,
  ): Promise<DecisionEvalRunResult>;
};

function splitList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function validateTargets(values: string[], source: string): PromptEvalTarget[] {
  for (const target of values) {
    if (!TARGETS.includes(target as PromptEvalTarget)) {
      throw new Error(`Invalid ${source} item: ${target}. Use ${TARGETS.join(', ')}.`);
    }
  }
  return values as PromptEvalTarget[];
}

function readTargets(): PromptEvalTarget[] {
  const requested = splitList(
    process.env.PROMPT_EVAL_TARGETS ?? process.env.DECISION_EVAL_TARGETS,
  );
  if (requested.length === 0) {
    const defaults = splitList(process.env.PROMPT_EVAL_DEFAULT_TARGETS);
    return defaults.length > 0
      ? validateTargets(defaults, 'PROMPT_EVAL_DEFAULT_TARGETS')
      : TARGETS;
  }
  return validateTargets(requested, 'PROMPT_EVAL_TARGETS');
}

function compactError(error: unknown): { kind: 'schema' | 'invoke'; message: string } {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  const kind = name === 'ZodError' || /structured output|schema|validation/i.test(message)
    ? 'schema'
    : 'invoke';
  return { kind, message: `${name}: ${message}`.slice(0, 500) };
}

function fingerprint(output: Record<string, unknown>): string {
  return JSON.stringify(output).replace(/\s+/g, ' ');
}

function previewOutput(output: Record<string, unknown>): string {
  return fingerprint(output).slice(0, 240);
}

function readRevision(): PromptEvalRevision {
  const commit = execFileSync(
    'git',
    ['rev-parse', 'HEAD'],
    { encoding: 'utf8' },
  ).trim();
  const changedPaths = [
    ...splitNullList(execFileSync('git', ['diff', '--name-only', '-z', 'HEAD'], { encoding: 'utf8' })),
    ...splitNullList(execFileSync(
      'git',
      ['ls-files', '--others', '--exclude-standard', '-z'],
      { encoding: 'utf8' },
    )),
  ].filter((value, index, values) => values.indexOf(value) === index).sort();
  const dirty = changedPaths.length > 0;
  if (dirty && process.env.PROMPT_EVAL_ALLOW_DIRTY !== '1') {
    throw new Error(
      'Prompt eval requires a clean working tree. Commit the candidate or set PROMPT_EVAL_ALLOW_DIRTY=1.',
    );
  }
  const workingTreeDiffSha256 = dirty ? hashWorkingTreeDiff(changedPaths) : null;
  return {
    commit,
    harnessCommit: process.env.PROMPT_EVAL_HARNESS_REVISION ?? (dirty ? 'working-tree' : commit),
    dirty,
    workingTreeDiffSha256,
    changedPaths,
  };
}

function splitNullList(value: string): string[] {
  return value.split('\0').map((item) => item.trim()).filter(Boolean);
}

function hashWorkingTreeDiff(changedPaths: string[]): string {
  const hash = createHash('sha256');
  hash.update(execFileSync('git', ['diff', '--binary', 'HEAD']));
  const untracked = new Set(splitNullList(execFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
  )));
  for (const path of changedPaths) {
    if (!untracked.has(path)) continue;
    hash.update(`\0${path}\0`);
    hash.update(readFileSync(resolve(path)));
  }
  return hash.digest('hex');
}

function getPromptEvalScenarios(): PromptEvalScenario[] {
  return [
    ...getDecisionEvalScenarios().map((scenario) => ({
      ...scenario,
      run: (
        model: AgentModels['act'],
        method: StructuredOutputMethod | undefined,
        config: RunnableConfig,
      ) => scenario.run(model, method, config),
    })),
    ...getAnswerEvalScenarios().map((scenario) => ({
      ...scenario,
      run: (
        model: AgentModels['act'],
        _method: StructuredOutputMethod | undefined,
        config: RunnableConfig,
      ) => scenario.run(model, config),
    })),
  ];
}

async function main() {
  const repeats = Number(
    process.env.PROMPT_EVAL_REPEATS
    ?? process.env.DECISION_EVAL_REPEATS
    ?? DEFAULT_REPEATS,
  );
  if (!Number.isInteger(repeats) || repeats <= 0) {
    throw new Error(`Invalid PROMPT_EVAL_REPEATS: ${process.env.PROMPT_EVAL_REPEATS ?? ''}`);
  }
  const revision = readRevision();
  const targets = readTargets();
  const requestedCases = splitList(
    process.env.PROMPT_EVAL_CASES ?? process.env.DECISION_EVAL_CASES,
  );
  const scenarios = getPromptEvalScenarios().filter((scenario) => (
    targets.includes(scenario.target)
    && (requestedCases.length === 0
      || requestedCases.includes(scenario.caseId)
      || requestedCases.includes(scenario.caseName))
  ));
  if (scenarios.length === 0) throw new Error('No prompt eval scenarios matched the requested filters.');

  const modelConfig = createDecisionEvalModel();
  const structuredOutputMethod = targets.some((target) => target !== 'answer')
    ? modelConfig.method ?? 'provider-default'
    : 'not-applicable';
  console.log('Orchestrator prompt stability eval');
  console.log(`Revision: ${revision.commit}${revision.dirty ? ' (dirty)' : ''}`);
  console.log(`Harness revision: ${revision.harnessCommit}`);
  console.log(`Model: ${modelConfig.label}`);
  console.log(`Model family: ${modelConfig.metadata.family}`);
  console.log(`Reasoning effort: ${modelConfig.metadata.reasoningEffort}`);
  console.log(`Structured output method: ${structuredOutputMethod}`);
  console.log(`Targets: ${targets.join(', ')}`);
  console.log(`Repeats: ${repeats.toString()}`);
  console.log(`Cases: ${scenarios.length.toString()}`);
  console.log('');

  const results: DecisionStabilityResult[] = [];
  for (const scenario of scenarios) {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const started = performance.now();
      const usageCollector = createPromptEvalUsageCollector();
      try {
        const result = await scenario.run(modelConfig.model, modelConfig.method, {
          callbacks: [usageCollector.callback],
          runName: `prompt-eval-${scenario.target}-${scenario.caseName}`,
          metadata: {
            promptEvalRevision: revision.commit,
            promptEvalCaseId: scenario.caseId,
            promptEvalRepeat: repeat,
          },
        });
        const usage = usageCollector.read();
        const failedScores = result.scores.filter(({ score }) => score !== 1).map(({ key }) => key);
        const ok = failedScores.length === 0;
        results.push({
          target: scenario.target,
          caseId: scenario.caseId,
          repeat,
          ok,
          durationMs: Math.round(performance.now() - started),
          verdict: result.verdict,
          outputShape: result.shape,
          outputFingerprint: fingerprint(result.output),
          failedScores,
          failureKind: null,
          error: null,
          usage,
          estimatedCostUsd: estimatePromptEvalCost(usage, modelConfig.pricing),
        });
        console.log(
          `[${ok ? 'PASS' : 'FAIL'}] ${scenario.target}/${scenario.caseName} `
          + `repeat=${repeat.toString()} verdict=${result.verdict}`
          + (failedScores.length > 0 ? ` failed=${failedScores.join(',')}` : '')
          + ` output=${previewOutput(result.output)}`,
        );
      } catch (error) {
        const failure = compactError(error);
        const usage = usageCollector.read();
        results.push({
          target: scenario.target,
          caseId: scenario.caseId,
          repeat,
          ok: false,
          durationMs: Math.round(performance.now() - started),
          verdict: null,
          outputShape: null,
          outputFingerprint: null,
          failedScores: [],
          failureKind: failure.kind,
          error: failure.message,
          usage,
          estimatedCostUsd: estimatePromptEvalCost(usage, modelConfig.pricing),
        });
        console.log(
          `[ERROR] ${scenario.target}/${scenario.caseName} repeat=${repeat.toString()} `
          + `${failure.kind}=${failure.message}`,
        );
      }
    }
  }

  console.log('\nStability summary:');
  const summaries = summarizeDecisionStability(results);
  for (const summary of summaries) {
    console.log(
      `- ${summary.target}/${summary.caseId}: ${summary.passed.toString()}/${summary.runs.toString()} passed; `
      + `verdicts=[${formatDistribution(summary.verdictDistribution)}]; `
      + `shapes=[${formatDistribution(summary.outputShapeDistribution)}]; `
      + `variants=${summary.outputVariants.toString()}; `
      + `schemaErrors=${summary.schemaFailures.toString()}; `
      + `invokeErrors=${summary.invokeFailures.toString()}; `
      + `meanMs=${summary.meanDurationMs.toString()}; `
      + `tokens=${summary.usageRuns.toString()}/${summary.runs.toString()} runs,${summary.totalTokens.toString()} total`
      + (summary.estimatedCostUsd === null ? '' : `; estimatedCostUsd=${summary.estimatedCostUsd.toString()}`)
      + (Object.keys(summary.failedScoreDistribution).length > 0
        ? `; failedScores=[${formatDistribution(summary.failedScoreDistribution)}]`
        : ''),
    );
  }

  const report = createPromptEvalReport({
    revision,
    model: modelConfig.metadata,
    structuredOutputMethod,
    pricing: modelConfig.pricing,
    selection: {
      targets,
      caseIds: scenarios.map(({ caseId }) => caseId),
      datasets: [...new Set(scenarios.map(({ datasetName }) => datasetName))],
      repeats,
    },
    results,
    summaries,
  });
  const defaultReportName = `prompt-stability-${revision.commit.slice(0, 12)}-${Date.now().toString()}.json`;
  const reportPath = resolve(
    process.env.PROMPT_EVAL_REPORT_PATH ?? resolve('.eval-results', defaultReportName),
  );
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const failed = results.filter(({ ok }) => !ok).length;
  console.log(`\nOverall: ${(results.length - failed).toString()}/${results.length.toString()} passed.`);
  console.log(`Report: ${reportPath}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
