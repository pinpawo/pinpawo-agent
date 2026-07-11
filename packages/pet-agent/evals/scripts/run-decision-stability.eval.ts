import { performance } from 'node:perf_hooks';
import {
  getDecisionEvalScenarios,
  type DecisionEvalTarget,
} from '../decision-eval-scenarios.ts';
import {
  formatDistribution,
  summarizeDecisionStability,
  type DecisionStabilityResult,
} from '../decision-stability.ts';
import { createDecisionEvalModel } from './decision-eval-model.ts';

const TARGETS: DecisionEvalTarget[] = ['entry', 'planner', 'capability', 'outcome'];
const DEFAULT_REPEATS = 5;

function splitList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function readTargets(): DecisionEvalTarget[] {
  const requested = splitList(process.env.DECISION_EVAL_TARGETS);
  if (requested.length === 0) return TARGETS;
  for (const target of requested) {
    if (!TARGETS.includes(target as DecisionEvalTarget)) {
      throw new Error(`Invalid DECISION_EVAL_TARGETS item: ${target}. Use ${TARGETS.join(', ')}.`);
    }
  }
  return requested as DecisionEvalTarget[];
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

async function main() {
  const repeats = Number(process.env.DECISION_EVAL_REPEATS ?? DEFAULT_REPEATS);
  if (!Number.isInteger(repeats) || repeats <= 0) {
    throw new Error(`Invalid DECISION_EVAL_REPEATS: ${process.env.DECISION_EVAL_REPEATS ?? ''}`);
  }
  const targets = readTargets();
  const requestedCases = splitList(process.env.DECISION_EVAL_CASES);
  const scenarios = getDecisionEvalScenarios().filter((scenario) => (
    targets.includes(scenario.target)
    && (requestedCases.length === 0
      || requestedCases.includes(scenario.caseId)
      || requestedCases.includes(scenario.caseName))
  ));
  if (scenarios.length === 0) throw new Error('No decision eval scenarios matched the requested filters.');

  const modelConfig = createDecisionEvalModel();
  console.log('Decision prompt stability eval');
  console.log(`Model: ${modelConfig.label}`);
  console.log(`Structured output method: ${modelConfig.method ?? 'default'}`);
  console.log(`Targets: ${targets.join(', ')}`);
  console.log(`Repeats: ${repeats.toString()}`);
  console.log(`Cases: ${scenarios.length.toString()}`);
  console.log('');

  const results: DecisionStabilityResult[] = [];
  for (const scenario of scenarios) {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const started = performance.now();
      try {
        const result = await scenario.run(modelConfig.model, modelConfig.method);
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
        });
        console.log(
          `[${ok ? 'PASS' : 'FAIL'}] ${scenario.target}/${scenario.caseName} `
          + `repeat=${repeat.toString()} verdict=${result.verdict}`
          + (failedScores.length > 0 ? ` failed=${failedScores.join(',')}` : '')
          + ` output=${previewOutput(result.output)}`,
        );
      } catch (error) {
        const failure = compactError(error);
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
      + `meanMs=${summary.meanDurationMs.toString()}`
      + (Object.keys(summary.failedScoreDistribution).length > 0
        ? `; failedScores=[${formatDistribution(summary.failedScoreDistribution)}]`
        : ''),
    );
  }

  const failed = results.filter(({ ok }) => !ok).length;
  console.log(`\nOverall: ${(results.length - failed).toString()}/${results.length.toString()} passed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
