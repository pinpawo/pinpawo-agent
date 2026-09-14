import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel, type BaseChatModelCallOptions } from '@langchain/core/language_models/chat_models';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRunSupervisorAgent } from '../src/agent/orchestrator/runSupervisor/agent';
import { createDecisionEvalModel } from './scripts/decision-eval-model';
import { scoreClosure } from './supervisor-delivery-closure';
import { projectHistoryEvidence, toolHistoryInput, withoutToolScope, type HistoryVariant, type HistoryMode } from './supervisor-tool-history';

const configPath = process.env.PROMPT_EVAL_CONFIG_PATH ?? join(homedir(), '.pinpawo/config.json');
const profileId = process.env.PROMPT_EVAL_PROFILE_ID ?? JSON.parse(readFileSync(configPath, 'utf8')).models.defaultProfileId;
const counts = (process.env.HISTORY_COUNTS ?? '0,40,120').split(',').map(Number);
const variants = (process.env.HISTORY_VARIANTS ?? 'baseline,prompt').split(',') as HistoryVariant[];
const modes = (process.env.HISTORY_MODES ?? 'entry,boundary').split(',') as HistoryMode[];
const repeats = Number(process.env.PROMPT_EVAL_REPEATS ?? 2);
if (counts.some(n => !Number.isInteger(n) || n < 0 || n > 300)
  || modes.some(m => !['entry', 'boundary', 'resume'].includes(m))
  || variants.some(v => !['baseline', 'prompt', 'projection'].includes(v))
  || !Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('Invalid evaluation matrix');
const output = process.env.PROMPT_EVAL_OUTPUT_DIR ?? '/tmp/supervisor-tool-history';
mkdirSync(output, { recursive: true });
const pending = counts.flatMap(count => modes.flatMap(mode =>
  Array.from({ length: repeats }, (_, repeat) => variants.map(variant => ({ count, mode, repeat, variant }))).flat()));
const rows: Array<Record<string, unknown>> = [];
await Promise.all(Array.from({ length: 2 }, async () => {
  while (pending.length) {
    const spec = pending.shift()!;
    const id = `${spec.mode}-${spec.count}-${spec.variant}-${spec.repeat}`;
    // Identical synthetic ids across variants/repeats; only the chosen treatment differs.
    const { input, expected } = toolHistoryInput(spec.mode, spec.count, `history-eval-${spec.mode}-${spec.count}`);
    const historicalCallIds = new Set(input.messages.flatMap(m => AIMessage.isInstance(m)
      ? (m.tool_calls ?? []).filter(c => c.name === 'delegate_capability').map(c => c.id!) : []));
    const subject = createDecisionEvalModel({ profileId, role: 'subject' });
    const turns: Array<Record<string, unknown>> = [];
    const started = Date.now();
    class ObservedModel extends BaseChatModel {
      private bound?: ReturnType<NonNullable<BaseChatModel['bindTools']>>;
      constructor() { super({}); }
      _llmType() { return 'supervisor-history-eval'; }
      bindTools(...args: Parameters<NonNullable<BaseChatModel['bindTools']>>) {
        this.bound = subject.model.bindTools!(...args);
        return this;
      }
      async _generate(messages: BaseMessage[], options: BaseChatModelCallOptions) {
        let projected: BaseMessage[] = messages;
        if (spec.variant === 'baseline') projected = withoutToolScope(messages);
        if (spec.variant === 'projection') projected = projectHistoryEvidence(messages, historicalCallIds);
        const turn: Record<string, unknown> = { index: turns.length, messageCount: projected.length,
          historyCalls: projected.flatMap(m => AIMessage.isInstance(m) ? m.tool_calls ?? [] : []).filter(c => historicalCallIds.has(c.id!)).length,
          inputHash: createHash('sha256').update(JSON.stringify(projected)).digest('hex') };
        turns.push(turn);
        if (turns.length === 1) writeFileSync(join(output, `${id}.input.json`), JSON.stringify(projected, null, 2));
        const turnStart = Date.now();
        try {
          if (!this.bound) throw new Error('Model tools were not bound');
          const message = await this.bound.invoke(projected, { ...options, callbacks: [] });
          turn.calls = message.tool_calls ?? [];
          turn.text = message.content;
          turn.usage = message.usage_metadata;
          return { generations: [{ message, text: message.text }] };
        } finally { turn.elapsedMs = Date.now() - turnStart; }
      }
    }
    let score: ReturnType<typeof scoreClosure> | undefined;
    let error: string | undefined;
    try {
      const result = await createRunSupervisorAgent({ model: new ObservedModel() }).invoke(input, {
        recursionLimit: 24, signal: AbortSignal.timeout(150_000),
      });
      score = scoreClosure(input, result, expected);
    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    if (!turns.length) throw new Error('Evaluation did not observe model input/output');
    const calls = turns.flatMap(t => (t.calls ?? []) as Array<{ name: string }>);
    const allowed = new Set(['submit_plan', 'adjust_plan', 'review_current', 'delegate_capability', ...(input.mode === 'entry' ? ['capability_details'] : [])]);
    const passed = !error && score?.passed === true && calls.every(c => allowed.has(c.name));
    const row = { id, passed, protocol: 'supervisor-runtime-briefing-v3', ...spec, model: subject.metadata.model, profileFingerprint: subject.metadata.fingerprint, elapsedMs: Date.now() - started,
      firstCalls: turns[0]?.calls, illegalCalls: calls.filter(c => !allowed.has(c.name)),
      delegateCalls: calls.filter(c => c.name === 'delegate_capability').length, score, error, turns };
    rows.push(row);
    writeFileSync(join(output, `${id}.json`), JSON.stringify(row, null, 2));
    writeFileSync(join(output, 'summary.json'), JSON.stringify({ profileId, counts, modes, variants, repeats, rows }, null, 2));
    console.log(JSON.stringify({ id, elapsedMs: row.elapsedMs, delegateCalls: row.delegateCalls,
      illegalCalls: row.illegalCalls.map(c => c.name), score, error }));
  }
}));

process.exitCode = rows.some(row => row.passed !== true) ? 1 : 0;
