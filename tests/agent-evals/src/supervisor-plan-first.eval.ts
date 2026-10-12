import type { BaseMessage } from '@langchain/core/messages';
import { BaseChatModel, type BaseChatModelCallOptions } from '@langchain/core/language_models/chat_models';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRunSupervisorProbe } from '../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/testing';
import { createDecisionEvalModel } from './scripts/decision-eval-model';
import { GUIDANCE_VARIANTS, planFirstInput, planFirstScenarios, scorePlanFirst, withGuidance, type GuidanceVariant as Variant } from './supervisor-plan-first';

/**
 * Real-model eval: after plan_request, does a new run's Supervisor call
 * submit_plan before delegating, even when every earlier run in main history
 * reads "plan_request → delegate_capability"? `ask` scenarios guard the other
 * side: a request only the user can unblock must not be delegated.
 *
 * Env: PLAN_FIRST_PRIOR_COUNTS (default 0,3,8,16), PLAN_FIRST_VARIANTS (default current,previous;
 * also pr955), PROMPT_EVAL_REPEATS (default 3), PLAN_FIRST_CONCURRENCY (default 4),
 * EVAL_CASES (scenario names), PROMPT_EVAL_OUTPUT_DIR.
 * Baselines swap in earlier Entry wording: `pr955` the first plan-first attempt, `previous` before it.
 */

const configPath = process.env.PROMPT_EVAL_CONFIG_PATH ?? join(homedir(), '.pinpawo', 'config.json');
const profileId = process.env.PROMPT_EVAL_PROFILE_ID
  ?? (JSON.parse(readFileSync(configPath, 'utf8')) as { models: { defaultProfileId: string } }).models.defaultProfileId;
const priorCounts = (process.env.PLAN_FIRST_PRIOR_COUNTS ?? '0,3,8,16').split(',').map(Number);
const variants = (process.env.PLAN_FIRST_VARIANTS ?? 'current,previous').split(',') as Variant[];
const repeats = Number(process.env.PROMPT_EVAL_REPEATS ?? 3);
const concurrency = Number(process.env.PLAN_FIRST_CONCURRENCY ?? 4);
const selected = new Set(process.env.EVAL_CASES?.split(',').filter(Boolean) ?? []);
if (priorCounts.some((n) => !Number.isInteger(n) || n < 0 || n > 40)
  || variants.some((v) => !GUIDANCE_VARIANTS.includes(v))
  || !Number.isInteger(repeats) || repeats < 1 || repeats > 10
  || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Invalid evaluation matrix');
const scenarioNames = planFirstScenarios(0).map((s) => s.name);
if ([...selected].some((name) => !scenarioNames.includes(name))) throw new Error('Unknown EVAL_CASES entry.');
const output = process.env.PROMPT_EVAL_OUTPUT_DIR ?? '/tmp/supervisor-plan-first';
mkdirSync(output, { recursive: true });

const pending = priorCounts.flatMap((count) => planFirstScenarios(count)
  .filter((scenario) => selected.size === 0 || selected.has(scenario.name))
  .flatMap((scenario) => variants.flatMap((variant) =>
    Array.from({ length: repeats }, (_, repeat) => ({ count, scenario, variant, repeat })))));
const rows: Array<Record<string, unknown>> = [];

await Promise.all(Array.from({ length: concurrency }, async () => {
  while (pending.length) {
    const spec = pending.shift()!;
    const id = `${spec.scenario.name}-${spec.count}-${spec.variant}-${spec.repeat}`;
    const subject = createDecisionEvalModel({ profileId, role: 'subject' });
    const turns: Array<{ calls: Array<{ name: string; args?: unknown }>; text: unknown }> = [];
    class ObservedModel extends BaseChatModel {
      private bound?: ReturnType<NonNullable<BaseChatModel['bindTools']>>;
      constructor() { super({}); }
      _llmType() { return 'supervisor-plan-first-eval'; }
      bindTools(...args: Parameters<NonNullable<BaseChatModel['bindTools']>>) {
        this.bound = subject.model.bindTools!(...args);
        return this;
      }
      async _generate(messages: BaseMessage[], options: BaseChatModelCallOptions) {
        if (!this.bound) throw new Error('Model tools were not bound');
        const message = await this.bound.invoke(withGuidance(messages, spec.variant), { ...options, callbacks: [] });
        turns.push({ calls: (message.tool_calls ?? []).map(({ name, args }) => ({ name, args })), text: message.content });
        return { generations: [{ message, text: message.text }] };
      }
    }
    let error: string | undefined;
    try {
      await createRunSupervisorProbe({ model: new ObservedModel() }).invoke(
        planFirstInput(spec.scenario, `plan-first-${id}`),
        { recursionLimit: 16, signal: AbortSignal.timeout(150_000) },
      );
    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    const calls = turns.flatMap((turn) => turn.calls);
    const score = scorePlanFirst(calls, spec.scenario.expect);
    const row = { id, case: spec.scenario.name, expect: spec.scenario.expect, history: spec.count, priorRuns: spec.scenario.prior.length,
      variant: spec.variant, repeat: spec.repeat, model: subject.metadata.model, passed: score.passed, first: score.first,
      delegatedBeforePlan: score.delegatedBeforePlan, modelTurns: turns.length,
      callSequence: calls.map((call) => call.name), error, turns };
    rows.push(row);
    writeFileSync(join(output, `${id}.json`), JSON.stringify(row, null, 2));
    console.log(JSON.stringify({ id, passed: row.passed, first: row.first, callSequence: row.callSequence, error }));
  }
}));

const summary: Record<string, { passed: number; total: number }> = {};
const tally = (key: string, passed: unknown) => {
  summary[key] ??= { passed: 0, total: 0 };
  summary[key].total += 1;
  if (passed) summary[key].passed += 1;
};
for (const row of rows) {
  tally(`${row.variant} / ${row.case} / history=${row.history}`, row.passed);
  tally(`${row.variant} / ALL`, row.passed);
}
writeFileSync(join(output, 'summary.json'), JSON.stringify({ profileId, priorCounts, variants, repeats, summary, rows }, null, 2));
for (const [key, { passed, total }] of Object.entries(summary).sort()) console.log(`${key}: ${passed}/${total}`);
// Gate only on the shipped guidance; earlier wordings are baselines.
process.exitCode = rows.some((row) => row.variant === 'current' && !row.passed) ? 1 : 0;
