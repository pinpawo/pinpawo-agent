import { createHash } from 'node:crypto';
import { buildRunSupervisorAgentSystemPrompt } from '../src/agent/orchestrator/prompts/runSupervisorAgent';
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRunSupervisorProbe as createRunSupervisorAgent } from '../src/agent/orchestrator/runSupervisor/testing';
import { createDecisionEvalModel } from './scripts/decision-eval-model';
import { supervisorDeliveryClosureDataset } from './datasets/supervisor-delivery-closure';
import { closureInput, scoreClosure } from './supervisor-delivery-closure';

const configPath = process.env.PROMPT_EVAL_CONFIG_PATH ?? join(homedir(), '.pinpawo/config.json');
const profileId = process.env.PROMPT_EVAL_PROFILE_ID ?? JSON.parse(readFileSync(configPath, 'utf8')).models.defaultProfileId;
const repeats = Number(process.env.PROMPT_EVAL_REPEATS ?? 1);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('repeats must be 1..10');
const output = process.env.PROMPT_EVAL_OUTPUT_DIR ?? '/tmp/supervisor-delivery-closure';
mkdirSync(output, { recursive: true });
const cases = supervisorDeliveryClosureDataset.cases.filter(c => !process.env.PROMPT_EVAL_CASE || c.name === process.env.PROMPT_EVAL_CASE);
if (!cases.length) throw new Error('No matching cases');
const pending = Array.from({ length: repeats }, (_, repeat) => cases.map(c => ({ c, repeat }))).flat();
const promptHash = createHash('sha256').update(buildRunSupervisorAgentSystemPrompt('entry') + buildRunSupervisorAgentSystemPrompt('boundary')).digest('hex');
const datasetHash = createHash('sha256').update(JSON.stringify(cases)).digest('hex');
const scores: unknown[] = [];
let failures = 0;
await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
  while (pending.length) {
    const { c, repeat } = pending.shift()!;
    const id = `${c.name}-${repeat}`;
    const input = closureInput(c.input, id);
    const subject = createDecisionEvalModel({ profileId, role: 'subject' });
    const started = Date.now();
    const modelStarts = new Map<string, number>();
    const timings: Array<Record<string, unknown>> = [];
    const record = (event: Record<string, unknown>) => {
      const timed = { elapsedMs: Date.now() - started, ...event };
      timings.push(timed);
      appendFileSync(join(output, `${id}.timing.jsonl`), JSON.stringify(timed) + '\n');
    };
    const callbacks = [{
      handleChatModelStart: (_model: unknown, messages: Array<Array<{ content: unknown }>>, runId: string) => {
        modelStarts.set(runId, Date.now());
        record({ event: 'model.start', runId, messageCount: messages[0]?.length, inputChars: JSON.stringify(messages).length });
      },
      handleLLMEnd: (result: { generations: Array<Array<{ message?: { tool_calls?: Array<{ name: string; args: unknown }>; invalid_tool_calls?: unknown; usage_metadata?: unknown }; generationInfo?: unknown }>> }, runId: string) => {
        record({ event: 'model.end', runId, durationMs: Date.now() - (modelStarts.get(runId) ?? started),
          generations: result.generations.flat().map(g => ({ toolCalls: g.message?.tool_calls, invalidToolCalls: g.message?.invalid_tool_calls, usage: g.message?.usage_metadata, info: g.generationInfo })) });
      },
      handleLLMError: (error: Error, runId: string) => record({ event: 'model.error', runId, durationMs: Date.now() - (modelStarts.get(runId) ?? started), error: error.name }),
    }];
    try {
      const result = await createRunSupervisorAgent({ model: subject.model }).invoke(input, { recursionLimit: 100, signal: AbortSignal.timeout(240_000), callbacks });
      const score = { id, ...scoreClosure(input, result, c.expected) };
      writeFileSync(join(output, `${id}.json`), JSON.stringify({ profileId, promptHash, datasetHash, elapsedMs: Date.now() - started, timings, modelTimeoutMs: subject.metadata.timeoutMs, input: c.input, score, messages: result.messages }, null, 2));
      scores.push(score); if (!score.passed) failures++;
      console.log(JSON.stringify({ id, passed: score.passed, actual: score.actual, expected: score.expected }));
    } catch (error) {
      failures++;
      const failure = { id, passed: false, elapsedMs: Date.now() - started, timings, modelTimeoutMs: subject.metadata.timeoutMs, error: error instanceof Error ? error.name : 'UnknownError', detail: error instanceof Error ? error.message : 'UnknownError' };
      writeFileSync(join(output, `${id}.json`), JSON.stringify(failure, null, 2));
      scores.push(failure);
      console.log(JSON.stringify({ id, passed: false, error: error instanceof Error ? error.name : 'UnknownError' }));
    }
  }
}));
writeFileSync(join(output, 'summary.json'), JSON.stringify({ profileId, promptHash, datasetHash, repeats, failures, scores }, null, 2));
process.exitCode = failures ? 1 : 0;
