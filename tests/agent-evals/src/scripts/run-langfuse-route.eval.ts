import { orchestratorRouteDataset } from '../datasets/orchestrator-route.ts';
import {
  DATASET_NAME,
  LLM_BASE_URL,
  LLM_MODEL,
  activeCapabilityCorrectness,
  delegateBias,
  finishBias,
  modeCorrectness,
  phaseCorrectness,
  routeCorrectness,
  target,
} from '../orchestrator-route.eval.ts';
import { resolveLangfuseConfig } from './langfuse-api.ts';
import { writeLangfuseEvalResult } from './langfuse-eval-writer.ts';
import { LangfuseV4Runtime, createLangfuseV4Runtime } from './langfuse-v4-runtime.ts';

type ScoreResult = {
  key: string;
  score: number;
  comment?: string;
};

type EvalRow = {
  id: string;
  name: string;
  suite: string;
  tags: string[];
  ok: boolean;
  durationMs: number;
  scores: ScoreResult[];
  output: Record<string, unknown>;
  error?: string;
};

const scoreKeys = [
  'route_correct',
  'mode_correct',
  'phase_correct',
  'active_capability_correct',
  'finish_correct',
  'delegate_correct',
];

const evaluators = [
  routeCorrectness,
  modeCorrectness,
  phaseCorrectness,
  activeCapabilityCorrectness,
  finishBias,
  delegateBias,
];

function splitList(value: string | undefined): string[] {
  return value?.split(',')
    .map((item) => item.trim())
    .filter(Boolean) ?? [];
}

function selectedCases() {
  const requested = new Set(splitList(process.env.EVAL_CASES));
  if (requested.size === 0) return orchestratorRouteDataset.cases;
  return orchestratorRouteDataset.cases.filter((testCase) =>
    requested.has(testCase.id) || requested.has(testCase.name),
  );
}

function compactError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.slice(0, 800);
  }
  return String(error).slice(0, 800);
}

function runEvaluators(
  outputs: Record<string, unknown>,
  referenceOutputs: Record<string, unknown>,
): ScoreResult[] {
  return evaluators.map((evaluator) => evaluator({ outputs, referenceOutputs }));
}

function scorePasses(score: ScoreResult): boolean {
  return score.score === 1;
}

function scoreApplies(score: ScoreResult): boolean {
  return !score.comment?.startsWith('No expected ');
}

async function writeLangfuseResult(params: {
  runtime: LangfuseV4Runtime;
  runName: string;
  testCase: typeof orchestratorRouteDataset.cases[number];
  row: EvalRow;
}) {
  await writeLangfuseEvalResult({
    runtime: params.runtime,
    datasetName: DATASET_NAME,
    runName: params.runName,
    traceName: 'orchestrator-route-eval',
    testCase: params.testCase,
    output: params.row.output,
    scores: params.row.scores,
    durationMs: params.row.durationMs,
    error: params.row.error,
    metadata: { ok: params.row.ok },
  });
}

function printSummary(rows: EvalRow[]) {
  console.log('\n=== Langfuse route eval complete ===');
  console.log(`Cases: ${rows.filter((row) => row.ok).length}/${rows.length} passed`);

  const tags = orchestratorRouteDataset.metadata.areas.filter((tag) =>
    rows.some((row) => row.tags.includes(tag)),
  );
  const knownTags = new Set<string>(tags);
  const unknownTags = [...new Set(rows.flatMap((row) => row.tags))]
    .filter((tag) => !knownTags.has(tag))
    .sort();

  console.log('\nBy example tag:');
  for (const tag of [...tags, ...unknownTags]) {
    const taggedRows = rows.filter((row) => row.tags.includes(tag));
    const passed = taggedRows.filter((row) => row.ok).length;
    console.log(`${tag}: ${passed}/${taggedRows.length} cases passed`);
  }

  console.log('\nBy score dimension:');
  for (const key of scoreKeys) {
    const scores = rows.flatMap((row) => row.scores.filter((score) => score.key === key));
    const applicableScores = scores.filter(scoreApplies);
    const passed = applicableScores.filter(scorePasses).length;
    const skipped = scores.length - applicableScores.length;
    const skippedSuffix = skipped > 0 ? `, ${skipped} not applicable` : '';
    console.log(`${key}: ${passed}/${applicableScores.length} applicable passed${skippedSuffix}`);
  }

  const failed = rows.filter((row) => !row.ok);
  if (failed.length === 0) return;

  console.log('\nFailures:');
  for (const row of failed) {
    const failedScores = row.scores.filter((score) => !scorePasses(score));
    const comments = failedScores.map((score) => `${score.key}: ${score.comment ?? score.score}`).join(' | ');
    console.log(`- ${row.name}: ${row.error ?? comments}`);
  }
}

async function main() {
  const config = resolveLangfuseConfig();
  const runtime = createLangfuseV4Runtime(config);
  const cases = selectedCases();
  if (cases.length === 0) {
    throw new Error(`No eval cases selected. EVAL_CASES=${process.env.EVAL_CASES ?? '(unset)'}`);
  }

  const runName = process.env.LANGFUSE_RUN_NAME
    || `orchestrator-route-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  console.log(`Running Langfuse route eval: ${runName}`);
  console.log(`Dataset: ${DATASET_NAME}`);
  console.log(`Model: ${LLM_MODEL} @ ${LLM_BASE_URL}`);
  console.log(`Langfuse: ${config.baseUrl}`);
  console.log(`Cases: ${cases.length}\n`);

  const rows: EvalRow[] = [];
  for (const testCase of cases) {
    const started = performance.now();
    try {
      const output = await target(testCase.input);
      const scores = runEvaluators(output, testCase.expected);
      const row = {
        id: testCase.id,
        name: testCase.name,
        suite: testCase.suite,
        tags: testCase.tags,
        ok: scores.every(scorePasses),
        durationMs: Math.round(performance.now() - started),
        scores,
        output,
      };
      await writeLangfuseResult({ runtime, runName, testCase, row });
      rows.push(row);
      console.log(`[${row.ok ? 'PASS' : 'FAIL'}] ${testCase.name} (${row.durationMs}ms)`);
    } catch (error) {
      const row = {
        id: testCase.id,
        name: testCase.name,
        suite: testCase.suite,
        tags: testCase.tags,
        ok: false,
        durationMs: Math.round(performance.now() - started),
        scores: [{ key: 'run_error', score: 0, comment: compactError(error) }],
        output: {},
        error: compactError(error),
      };
      await writeLangfuseResult({ runtime, runName, testCase, row });
      rows.push(row);
      console.log(`[ERROR] ${testCase.name} (${row.durationMs}ms): ${row.error}`);
    }
  }

  printSummary(rows);
  await runtime.shutdown();
  if (rows.some((row) => !row.ok)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
