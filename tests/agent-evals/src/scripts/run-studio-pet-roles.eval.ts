import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  studioPetRoleCases,
  type StudioPetRoleCase,
} from '../datasets/studio-pet-roles.ts';
import type { DecisionContractScore } from '../decision-contract-scorers.ts';
import { getDecisionEvalScenarios, type DecisionEvalScenario } from '../decision-eval-scenarios.ts';
import type { PromptEvalModelMetadata } from '../prompt-eval-report.ts';
import { createPromptEvalUsageCollector } from '../prompt-eval-usage.ts';
import { PromptEvalJudgeError } from '../prompt-goal-evaluator.ts';
import { runStudioPetRoleCase, StudioPetRoleInvocationError, StudioPetRoleJudgeError } from '../studio-pet-role-evaluation.ts';
import { createStudioPetModelObserver } from '../studio-pet-model-observer.ts';
import { createDecisionEvalModel } from './decision-eval-model.ts';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CASE_TIMEOUT_MS = 180_000;
const RECURSION_LIMIT = 40;
const ROLES = ['issuer', 'executor', 'reviewer', 'wiki'] as const;

class EvalOptionsError extends Error {}

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  if (value === undefined || value === '0') return false;
  if (value === '1') return true;
  throw new EvalOptionsError(`${name} must be 0 or 1.`);
}

export function readStudioPetRoleEvalOptions(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
) {
  if (argv.some((arg) => arg !== '--list')) {
    throw new EvalOptionsError('Only --list is supported as a command-line option.');
  }
  const repeatText = (env.PROMPT_EVAL_REPEATS ?? '3').trim();
  if (!/^(?:[1-9]|10)$/.test(repeatText)) {
    throw new EvalOptionsError('PROMPT_EVAL_REPEATS must be an integer from 1 to 10.');
  }
  const baseline = flag(env, 'STUDIO_PET_EVAL_BASELINE');
  const captureSyntheticContent = flag(env, 'STUDIO_PET_EVAL_CAPTURE_PROMPTS');
  if (captureSyntheticContent && env.STUDIO_PET_EVAL_CHANNEL_PROMPT_FILE !== undefined) {
    throw new EvalOptionsError('STUDIO_PET_EVAL_CAPTURE_PROMPTS only supports the public synthetic announcement.');
  }
  const caseFilter = env.PROMPT_EVAL_CASE?.trim();
  const roleFilter = env.STUDIO_PET_EVAL_ROLE?.trim();
  if (env.PROMPT_EVAL_CASE !== undefined && !caseFilter) {
    throw new EvalOptionsError('PROMPT_EVAL_CASE must be a case ID or name.');
  }
  if (env.STUDIO_PET_EVAL_ROLE !== undefined
    && !ROLES.some((role) => role === roleFilter)) {
    throw new EvalOptionsError('STUDIO_PET_EVAL_ROLE must be issuer, executor, reviewer, or wiki.');
  }
  if (caseFilter && !studioPetRoleCases.some(({ id, name }) => (
    id === caseFilter || name === caseFilter
  ))) {
    throw new EvalOptionsError('Unknown PROMPT_EVAL_CASE; use --list to see available cases.');
  }
  const cases = studioPetRoleCases.filter(({ id, name, role }) => (
    (!caseFilter || caseFilter === id || caseFilter === name)
    && (!roleFilter || roleFilter === role)
  ));
  if (cases.length === 0) {
    throw new EvalOptionsError('No cases match the combined case and role filters.');
  }
  const list = argv.includes('--list');
  const subjectProfileId = env.PROMPT_EVAL_MODEL_PROFILE_ID?.trim();
  const judgeProfileId = env.PROMPT_EVAL_JUDGE_PROFILE_ID?.trim();
  if (!list && !subjectProfileId) {
    throw new EvalOptionsError('PROMPT_EVAL_MODEL_PROFILE_ID is required.');
  }
  if (!list && !judgeProfileId) {
    throw new EvalOptionsError('PROMPT_EVAL_JUDGE_PROFILE_ID is required.');
  }
  return { list, cases, repeats: Number(repeatText), subjectProfileId, judgeProfileId, baseline, captureSyntheticContent };
}

export function assertDistinctStudioPetEvalModels(
  subject: Pick<PromptEvalModelMetadata, 'fingerprint'>,
  judge: Pick<PromptEvalModelMetadata, 'fingerprint'>,
) {
  if (!subject.fingerprint || !judge.fingerprint
    || subject.fingerprint === judge.fingerprint) {
    throw new EvalOptionsError('Subject and judge must have different resolved profile fingerprints.');
  }
}

export type StudioPetEvalFailure = 'invoke' | 'evaluation' | 'schema' | 'timeout';

export function classifyStudioPetEvalError(error: unknown): StudioPetEvalFailure {
  if (error instanceof PromptEvalJudgeError) return 'evaluation';
  if (error instanceof StudioPetRoleInvocationError) return classifyStudioPetEvalError(error.cause);
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) return 'timeout';
  if (error instanceof Error && error.name === 'ZodError') return 'schema';
  return 'invoke';
}

type StudioPetEvalOutcome = {
  scores: readonly DecisionContractScore[];
  failureKind: StudioPetEvalFailure | null;
};

export function summarizeStudioPetRoleEvalResults(results: readonly StudioPetEvalOutcome[]) {
  const passed = results.filter(({ scores, failureKind }) => (
    failureKind === null && scores.length > 0 && scores.every(({ score }) => score === 1)
  )).length;
  const errors = results.filter(({ failureKind }) => failureKind !== null).length;
  return {
    runs: results.length,
    passed,
    failed: results.length - passed,
    scoreFailures: results.length - passed - errors,
    errors,
    exitCode: passed === results.length && results.length > 0 ? 0 : 1,
  };
}

function readRevision() {
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const commit = git('rev-parse', 'HEAD').trim();
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z')
    .split('\0').filter(Boolean).sort();
  const changed = git('diff', '--name-only', '-z', 'HEAD').split('\0').filter(Boolean);
  const dirty = changed.length > 0 || untracked.length > 0;
  const hash = createHash('sha256').update(git('diff', '--binary', 'HEAD'));
  for (const path of untracked) {
    hash.update(`\0${path}\0`).update(readFileSync(resolve(REPOSITORY_ROOT, path)));
  }
  return { commit, dirty, workingTreeDiffSha256: dirty ? hash.digest('hex') : null };
}

type StudioPetEvalResult = StudioPetEvalOutcome & {
  caseId: string;
  role: StudioPetRoleCase['role'];
  phase: StudioPetRoleCase['phase'];
  repeat: number;
  input: StudioPetRoleCase;
  output: Record<string, unknown> | null;
  contextHash: string | null;
  evaluationSummary: string | null;
  startedAt: string;
  durationMs: number;
  usage: ReturnType<ReturnType<typeof createPromptEvalUsageCollector>['read']>;
  evaluationUsage: ReturnType<ReturnType<typeof createPromptEvalUsageCollector>['read']>;
};

type RunnerDependencies = {
  createModel?: typeof createDecisionEvalModel;
  runCase?: typeof runStudioPetRoleCase;
  runBaseline?: DecisionEvalScenario['run'];
  log?: (message: string) => void;
};

export async function runStudioPetRoleEval(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
  dependencies: RunnerDependencies = {},
): Promise<number> {
  const options = readStudioPetRoleEvalOptions(env, argv);
  const log = dependencies.log ?? console.log;
  if (options.list) {
    for (const testCase of options.cases) {
      log(`${testCase.id}\t${testCase.role}\t${testCase.phase}\t${testCase.name}`);
    }
    return 0;
  }
  const createModel = dependencies.createModel ?? createDecisionEvalModel;
  // Do not print profile-loader errors: provider configuration can contain credentials.
  const resolveModel = (role: 'subject' | 'judge', profileId: string) => {
    try { return createModel({ role, profileId, env }); } catch {
      throw new EvalOptionsError(`Unable to resolve the ${role} model profile; check local configuration.`);
    }
  };
  const subject = resolveModel('subject', options.subjectProfileId!);
  const judge = resolveModel('judge', options.judgeProfileId!);
  assertDistinctStudioPetEvalModels(subject.metadata, judge.metadata);
  const announcementFile = env.STUDIO_PET_EVAL_CHANNEL_PROMPT_FILE;
  const channelAnnouncement = announcementFile ? readFileSync(resolve(announcementFile), 'utf8') : undefined;
  if (channelAnnouncement !== undefined && !channelAnnouncement.trim()) {
    throw new EvalOptionsError('STUDIO_PET_EVAL_CHANNEL_PROMPT_FILE must contain a non-empty announcement.');
  }
  const runCase = dependencies.runCase ?? runStudioPetRoleCase;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const outputDir = resolve(env.PROMPT_EVAL_OUTPUT_DIR
    ?? `/tmp/studio-pet-role-eval/${startedAt.replace(/[:.]/g, '-')}`);
  const reportPath = resolve(outputDir, 'report.json');
  const metadata = {
    reportVersion: 2,
    kind: 'studio-pet-roles',
    scope: 'Synthetic role decisions and continuous flows with controlled Capability deliveries; no real domain operations are performed.',
    captureSyntheticContent: options.captureSyntheticContent,
    startedAt,
    revision: readRevision(),
    datasetSha256: createHash('sha256').update(JSON.stringify(studioPetRoleCases)).digest('hex'),
    channelAnnouncement: channelAnnouncement === undefined ? { source: 'synthetic-default' } : {
      source: 'local-file', sha256: createHash('sha256').update(channelAnnouncement).digest('hex'),
    },
    subject: {
      ...subject.metadata,
      decisionMethod: 'native-tools',
      configuredStructuredOutputMethod: subject.method ?? 'provider-default',
    },
    judge: { ...judge.metadata, structuredOutputMethod: judge.method ?? 'provider-default' },
    selection: { caseIds: options.cases.map(({ id }) => id), repeats: options.repeats },
    limits: { caseTimeoutMs: CASE_TIMEOUT_MS, recursionLimit: RECURSION_LIMIT },
  };
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const results: StudioPetEvalResult[] = [];
  const baselineScenario = getDecisionEvalScenarios('entry_answer')
    .find(({ caseName }) => caseName === 'repository-task-enters-supervisor');
  if (!baselineScenario) throw new EvalOptionsError('The existing Entry baseline scenario is unavailable.');
  const baselineResults: Array<StudioPetEvalOutcome & {
    repeat: number;
    output: Record<string, unknown> | null;
    durationMs: number;
    usage: ReturnType<ReturnType<typeof createPromptEvalUsageCollector>['read']>;
    modelCalls: ReturnType<ReturnType<typeof createStudioPetModelObserver>['read']>;
  }> = [];
  const saveReport = (complete: boolean) => {
    writeFileSync(reportPath, `${JSON.stringify({
      ...metadata,
      complete,
      durationMs: Math.round(performance.now() - started),
      results,
      summary: summarizeStudioPetRoleEvalResults(results),
      baseline: {
        enabled: options.baseline,
        scope: 'Existing generic Entry route and native-tool schema checks with the same subject model; no role-semantic judge or Studio workflow acceptance.',
        caseId: baselineScenario.caseId,
        caseName: baselineScenario.caseName,
        subjectFingerprint: subject.metadata.fingerprint,
        results: baselineResults,
        summary: options.baseline ? summarizeStudioPetRoleEvalResults(baselineResults) : null,
      },
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  };
  saveReport(false);
  if (options.baseline) {
    const runBaseline = dependencies.runBaseline ?? baselineScenario.run;
    for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
      const baselineStarted = performance.now();
      const usage = createPromptEvalUsageCollector();
      const observer = createStudioPetModelObserver({ petRole: 'generic-entry-baseline', defaultStage: 'entry',
        captureSyntheticContent: options.captureSyntheticContent });
      const result: typeof baselineResults[number] = {
        repeat, output: null, scores: [], failureKind: null, durationMs: 0, usage: null, modelCalls: [],
      };
      try {
        const evaluated = await runBaseline(subject.model, subject.method, {
          signal: AbortSignal.timeout(CASE_TIMEOUT_MS), recursionLimit: RECURSION_LIMIT,
          callbacks: [usage.callback, observer.callback], runName: `studio-pet-entry-baseline-${repeat.toString()}`,
        });
        result.output = evaluated.output;
        result.scores = evaluated.scores;
      } catch (error) {
        result.failureKind = classifyStudioPetEvalError(error);
      }
      result.durationMs = Math.round(performance.now() - baselineStarted);
      result.usage = usage.read();
      result.modelCalls = observer.read();
      baselineResults.push(result);
      saveReport(false);
      const passed = summarizeStudioPetRoleEvalResults([result]).passed === 1;
      log(`[BASELINE ${passed ? 'PASS' : 'FAIL'}] ${baselineScenario.caseName} repeat=${repeat.toString()}`
        + (result.failureKind ? ` failure=${result.failureKind}` : ''));
    }
  }
  for (const testCase of options.cases) {
    for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
      const caseStarted = performance.now();
      const usage = createPromptEvalUsageCollector();
      const evaluationUsage = createPromptEvalUsageCollector();
      const signal = AbortSignal.timeout(CASE_TIMEOUT_MS);
      const result: StudioPetEvalResult = {
        caseId: testCase.id,
        role: testCase.role,
        phase: testCase.phase,
        repeat,
        input: testCase,
        output: null,
        scores: [],
        contextHash: null,
        evaluationSummary: null,
        failureKind: null,
        startedAt: new Date().toISOString(),
        durationMs: 0,
        usage: null,
        evaluationUsage: null,
      };
      try {
        const evaluation = await runCase({
          testCase,
          model: subject.model,
          channelAnnouncement,
          captureSyntheticContent: options.captureSyntheticContent,
          config: {
            signal,
            recursionLimit: RECURSION_LIMIT,
            callbacks: [usage.callback],
            runName: `studio-pet-${testCase.id}-${repeat.toString()}`,
          },
          judge: {
            model: judge.model,
            method: judge.method,
            config: { signal, recursionLimit: RECURSION_LIMIT, callbacks: [evaluationUsage.callback] },
          },
        });
        Object.assign(result, evaluation);
      } catch (error) {
        if (error instanceof StudioPetRoleJudgeError || error instanceof StudioPetRoleInvocationError) Object.assign(result, error.partial);
        result.failureKind = classifyStudioPetEvalError(error);
      }
      result.durationMs = Math.round(performance.now() - caseStarted);
      result.usage = usage.read();
      result.evaluationUsage = evaluationUsage.read();
      results.push(result);
      saveReport(false);
      const passed = summarizeStudioPetRoleEvalResults([result]).passed === 1;
      log(`[${passed ? 'PASS' : 'FAIL'}] ${testCase.id} repeat=${repeat.toString()}`
        + (result.failureKind ? ` failure=${result.failureKind}` : ''));
    }
  }
  saveReport(true);
  const summary = summarizeStudioPetRoleEvalResults(results);
  log(`${summary.passed.toString()}/${summary.runs.toString()} passed. Report: ${reportPath}`);
  return summary.exitCode || (options.baseline ? summarizeStudioPetRoleEvalResults(baselineResults).exitCode : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStudioPetRoleEval().then((exitCode) => { process.exitCode = exitCode; }).catch((error) => {
    console.error(error instanceof EvalOptionsError
      ? error.message
      : 'Studio Pet eval could not complete; inspect local configuration and report permissions.');
    process.exitCode = 1;
  });
}
