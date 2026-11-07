import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { budgetHandoffDataset } from './datasets/budget-handoff.ts';
import { evaluateBudgetHandoffInvariants, runBudgetHandoffCase } from './budget-handoff-evaluation.ts';
import { evaluateModelCallExhaustionInvariants, runModelCallExhaustionCase } from './model-call-exhaustion-evaluation.ts';
import { evaluatePromptGoal } from './prompt-goal-evaluator.ts';
import { createPromptEvalUsageCollector } from './prompt-eval-usage.ts';
import { createDecisionEvalModel } from './scripts/decision-eval-model.ts';

process.env.LANGCHAIN_TRACING_V2 = 'false';
process.env.LANGSMITH_TRACING = 'false';

if (process.argv.includes('--list')) {
  console.log(JSON.stringify(budgetHandoffDataset.cases.map(item => ({ id: item.id, name: item.name })), null, 2));
} else {
  const repeats = Number(process.env.BUDGET_HANDOFF_EVAL_REPEATS ?? process.env.PROMPT_EVAL_REPEATS ?? 3);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('Eval repeats must be an integer from 1 to 10.');
  const selection = (process.env.BUDGET_HANDOFF_EVAL_CASES ?? '').split(',').map(item => item.trim()).filter(Boolean);
  const cases = budgetHandoffDataset.cases.filter(item => !selection.length || selection.includes(item.id) || selection.includes(item.name));
  if (!cases.length || selection.some(name => !cases.some(item => item.id === name || item.name === name))) throw new Error('Unknown eval case; use --list.');
  const configPath = process.env.PROMPT_EVAL_CONFIG_PATH ?? join(homedir(), '.pinpawo/config.json');
  const stored = JSON.parse(readFileSync(configPath, 'utf8')) as { models: { defaultProfileId: string; profiles: Record<string, unknown> } };
  const subjectProfileId = process.env.BUDGET_HANDOFF_EVAL_PROFILE ?? process.env.PROMPT_EVAL_MODEL_PROFILE_ID ?? stored.models.defaultProfileId;
  const subject = createDecisionEvalModel({ profileId: subjectProfileId, role: 'subject' });
  const requestedJudge = process.env.BUDGET_HANDOFF_EVAL_JUDGE_PROFILE ?? process.env.PROMPT_EVAL_JUDGE_PROFILE_ID;
  const judge = requestedJudge ? createDecisionEvalModel({ profileId: requestedJudge, role: 'judge' })
    : Object.keys(stored.models.profiles).filter(id => id !== subjectProfileId)
      .map(id => createDecisionEvalModel({ profileId: id, role: 'judge' }))
      .find(candidate => candidate.metadata.fingerprint !== subject.metadata.fingerprint);
  if (!judge || judge.metadata.fingerprint === subject.metadata.fingerprint) throw new Error('An independent judge profile with a different fingerprint is required.');
  const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  const harnessFiles = ['budget-handoff-evaluation.ts', 'model-call-exhaustion-evaluation.ts', 'budget-handoff.eval.ts', 'datasets/budget-handoff.ts'];
  const harnessHash = createHash('sha256');
  for (const name of harnessFiles) harnessHash.update(name).update(readFileSync(new URL(name, import.meta.url)));
  const outputDir = resolve(process.env.BUDGET_HANDOFF_EVAL_OUTPUT_DIR
    ?? `.eval-results/budget-handoff-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(outputDir, { recursive: true });
  const report = {
    reportVersion: 3, kind: 'budget-handoff', createdAt: new Date().toISOString(), revision,
    harnessHash: harnessHash.digest('hex'), datasetHash: createHash('sha256').update(JSON.stringify(cases)).digest('hex'),
    subject: subject.metadata, judge: judge.metadata,
    settings: { repeats, cases: cases.map(item => item.name), timeoutMs: 240_000, maxModelCalls: 20, maxDelegations: 4,
      contextWatermarkRatio: 0.85, baseline: 'No previous-revision real-model baseline has been run for this new harness.',
      acceptance: 'Briefings must reflect the current goal and prior progress, and the actual child model input must contain the current task/briefing and the exact preceding delivery. Repeated reads are reported as efficiency metrics rather than automatic handoff failures. Earlier reports used stricter no-reread/exact-attempt assertions and remain unchanged.',
      boundary: 'Context cases use the production Orchestrator graph with a scaled 16000-token child window and zero generation reserve. The model-call exhaustion case uses production createSubagent with a scaled two-call limit and controlled afterModel re-entry, then a manually driven fresh invocation; it does not exercise Supervisor scheduling. These are not provider-native million-token or default 100-call pressure tests. Evidence tools are synthetic; model decisions are real.' },
    results: [] as Array<Record<string, unknown>>,
  };
  const save = () => writeFileSync(join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  save();
  console.log(JSON.stringify({ event: 'start', subject: subject.metadata.profileId, judge: judge.metadata.profileId, repeats,
    cases: cases.map(item => item.name), report: join(outputDir, 'report.json') }));
  let failed = false;
  for (const testCase of cases) {
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const started = Date.now();
      console.log(JSON.stringify({ event: 'case.start', case: testCase.name, repeat }));
      try {
        const runCase = async () => {
          if (testCase.input.scenario === 'model-call-exhausted') {
            const executed = await runModelCallExhaustionCase({ input: testCase.input, model: subject.model });
            return { ...executed, invariants: evaluateModelCallExhaustionInvariants(executed.observation),
              briefingEvidence: [],
              attemptCount: executed.observation.attempts.length,
              contract: 'Real-model production createSubagent budget exhaustion with synthetic evidence tools and eval-only afterModel re-entry requesting one call beyond a two-call limit. A manually driven fresh invocation receives only the valid handoff. This case does not test Supervisor scheduling.' };
          }
          const executed = await runBudgetHandoffCase({ input: testCase.input, model: subject.model });
          return { ...executed, invariants: evaluateBudgetHandoffInvariants(executed.observation, testCase.expected),
            briefingEvidence: executed.diagnostics.delegationBriefings,
            attemptCount: executed.observation.executions.length,
            contract: 'Real-model budget handoff and hard context stop in the production orchestration graph, using synthetic evidence tools. Evaluate all deliveries, real tool effects and the final reply; a partial handoff is valid evidence but not completion, and a hard stop without delivery must not be invented into a handoff.' };
        };
        const executed = await runCase();
        const invariants = executed.invariants;
        const evaluatorUsage = createPromptEvalUsageCollector();
        let judgment: Awaited<ReturnType<typeof evaluatePromptGoal>> | null = null;
        let evaluationError: string | null = null;
        if (!executed.observation.invocationError) {
          try {
            judgment = await evaluatePromptGoal({
              judge: { model: judge.model, method: judge.method, config: { callbacks: [evaluatorUsage.callback], signal: AbortSignal.timeout(120_000) } },
              contract: executed.contract,
              objective: testCase.expected.objective, acceptanceCriteria: testCase.expected.acceptanceCriteria,
              evidence: { ...executed.observation, runtimeEvents: executed.diagnostics.runtimeEvents,
                delegationBriefings: executed.briefingEvidence,
                referenceFacts: { report: 'EVIDENCE-6429', successfulVerification: 'VERIFY-3817', expectedTicket: executed.diagnostics.expectedTicket } },
              candidateOutput: executed.observation,
            });
          } catch (error) { evaluationError = error instanceof Error ? `${error.name}: ${error.message}` : String(error); }
        }
        const passed = !executed.observation.invocationError && !evaluationError
          && invariants.every(item => item.passed) && Boolean(judgment?.scores.every(item => item.score === 1));
        const status = executed.observation.invocationError ? 'invoke_error' : evaluationError ? 'not_evaluable' : passed ? 'passed' : 'failed';
        const row = { case: testCase.name, repeat, status, passed, durationMs: Date.now() - started,
          invariants, judgment, evaluationError, observation: executed.observation, diagnostics: executed.diagnostics,
          usage: { subject: executed.usage, judge: evaluatorUsage.read() } };
        report.results.push(row);
        failed ||= !passed;
        writeFileSync(join(outputDir, `${testCase.name}-${repeat}.json`), `${JSON.stringify(row, null, 2)}\n`);
        save();
        console.log(JSON.stringify({ event: 'case.end', case: testCase.name, repeat, status,
          failedInvariants: invariants.filter(item => !item.passed).map(item => item.key), evaluationError,
          attempts: executed.attemptCount, durationMs: row.durationMs }));
      } catch (error) {
        const row = { case: testCase.name, repeat, status: 'invoke_error', passed: false, durationMs: Date.now() - started,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
        report.results.push(row); failed = true; save();
        console.log(JSON.stringify({ event: 'case.end', ...row }));
      }
    }
  }
  console.log(JSON.stringify({ event: 'complete', passed: report.results.filter(row => row.passed).length,
    total: report.results.length, report: join(outputDir, 'report.json') }));
  process.exitCode = failed ? 1 : 0;
}
