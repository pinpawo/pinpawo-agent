/**
 * Opt-in real-model evaluation of one Pet's public-Timeline Head decision.
 * No execution, delivery, tools, sessions, or live runtime observations are used.
 *
 * HEAD_EVAL_MODEL_PROFILE_ID (or PROMPT_EVAL_MODEL_PROFILE_ID) selects an
 * existing Host model profile; PROMPT_EVAL_CONFIG_PATH uses the existing resolver.
 * HEAD_EVAL_LIST_CASES=1 lists synthetic fixtures without loading model profiles.
 * HEAD_EVAL_CASE_IDS selects comma-separated IDs; HEAD_EVAL_REPEATS defaults to 3.
 * HEAD_EVAL_TIMEOUT_MS defaults to 60000. HEAD_EVAL_OUTPUT_DIR optionally writes
 * private, non-overwriting rows.jsonl/report.json for semantic review.
 *
 * Automated checks cover actions and structured payload invariants, not exact
 * prompt/answer prose. Review the supplied rubric against each reply/focus:
 * an automated pass is NOT evidence of factual grounding or task quality.
 */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildModel } from '../../../services/host/src/agent/agentModels.ts';
import { createLlmPetHeadDecider } from '../../../plugins/channel/src/channelPetHead.ts';
import { readResolvedProfile } from './scripts/decision-eval-model.ts';

type Decider = ReturnType<typeof createLlmPetHeadDecider>;
type Input = Parameters<Decider>[0];
type Decision = Awaited<ReturnType<Decider>>;
type Message = Input['messages'][number];

// These are synthetic routing.pets descriptions, projected onto each Head's
// own pet.description, not a separate role configuration or candidate selector.
const routing = { pets: {
  executor: 'Implement code changes, run tests, and deliver implementation results.',
  reviewer: 'Independently review code and PRs against human intent; report evidence and risks.',
  wiki: 'Maintain project documentation and explain documented behavior with sources and uncertainty.',
  issuer: 'Track issue progress against public evidence; distinguish reviewed, merged, and deployed.',
} };
type PetId = keyof typeof routing.pets;
const members: Input['members'] = [
  { participantId: 'human:barry', kind: 'human', label: 'Barry' },
  { participantId: 'human:alice', kind: 'human', label: 'Alice' },
  ...Object.keys(routing.pets).map(id => ({
    participantId: `pet:${id}`, kind: 'pet' as const, label: id,
  })),
];
const message = (sequence: number, participantId: string, body: string): Message => {
  const member = members.find(item => item.participantId === participantId);
  if (!member) throw new Error(`Unknown fixture member: ${participantId}`);
  return {
    messageId: `head-eval-${sequence}`, sequence, occurredAt: new Date(Date.UTC(2026, 10, 9, 10, sequence)).toISOString(),
    author: { ...member }, body, mentions: [],
  };
};
const human = (sequence: number, body: string) => message(sequence, 'human:barry', body);
type Case = {
  id: string; pet: PetId; expected: Decision['action'];
  messages: Message[]; history?: Message[]; execution?: Input['execution'];
  review: string;
};
const cases: Case[] = [
  {
    id: 'irrelevant-human-chat', pet: 'executor', expected: 'skip',
    messages: [human(1, 'Alice, are you free for lunch at noon?')],
    review: 'Stay silent. No technical request or useful contribution for this Pet.',
  },
  {
    id: 'executor-implements', pet: 'executor', expected: 'dispatch',
    messages: [human(1, 'Fix the empty CSV export bug, run the relevant tests, and prepare a draft PR. Do not merge or deploy.')],
    review: 'Focus on implementation and tests. Preserve the no-merge/no-deploy restriction; do not claim work already happened.',
  },
  {
    id: 'wiki-does-not-take-review', pet: 'wiki', expected: 'skip',
    messages: [human(1, 'Reviewer, independently review PR #410 for correctness. There are no documentation changes needed.')],
    review: 'Do not take another Pet’s review task or dispatch on its behalf.',
  },
  {
    id: 'public-answer', pet: 'issuer', expected: 'reply',
    history: [message(1, 'pet:reviewer', 'PR #410 head abc1234 passed independent review. It is still a draft, unmerged; deployment is unknown.')],
    messages: [human(2, 'Issuer, based only on the public update above, has PR #410 been reviewed and merged? Answer here; do not check any tools.')],
    review: 'Answer reviewed but not merged, attributing the public report. Do not upgrade this into deployed or independently verified.',
  },
  {
    id: 'unknown-private-progress', pet: 'executor', expected: 'reply',
    history: [human(1, 'Please investigate the CSV export bug.')],
    messages: [human(2, 'Executor, what progress can you confirm from this channel alone? Do not run anything or inspect tools; say if there is no confirmed progress.')],
    execution: { state: 'unknown' },
    review: 'Explicitly acknowledge no confirmed progress. Do not invent a session, command, test result, running job, percentage, PR, or completion.',
  },
  {
    id: 'confirmation-closeout', pet: 'issuer', expected: 'skip',
    execution: { state: 'unknown' },
    history: [
      message(1, 'pet:reviewer', 'PR #410 passed review, remains unmerged.'),
      message(2, 'pet:issuer', 'The public progress summary already says reviewed and unmerged. Only the human merge decision remains; no further summary is needed.'),
    ],
    messages: [message(3, 'pet:reviewer', 'Confirmed, that summary is accurate. No new findings or tasks.')],
    review: 'Avoid acknowledgement loops or duplicate dispatch after public agreement.',
  },
  {
    id: 'public-pet-review-handoff', pet: 'reviewer', expected: 'dispatch',
    history: [human(1, 'Implement the CSV fix and get independent review. Keep the PR draft; do not merge or deploy.')],
    messages: [message(2, 'pet:executor', 'PR #410 head abc1234 is ready for independent review. Local tests passed. Please review empty-list and normal CSV export behavior; the PR remains draft and unmerged.')],
    review: 'Dispatch this Pet’s independent review, retaining the exact PR/head and limits. Treat reported local tests as evidence to assess, not a completed independent review.',
  },
  {
    id: 'public-pet-wiki-handoff', pet: 'wiki', expected: 'dispatch',
    history: [human(1, 'Once the CSV fix is merged, update the Wiki export page to match main. Do not claim deployment unless verified.')],
    messages: [message(2, 'pet:executor', 'The CSV fix is merged at abc1234. Empty exports now contain headers. The Wiki still says they fail; please check that commit and update the page. Production deployment is unknown.')],
    review: 'Dispatch documentation verification/update against abc1234, preserving uncertainty about deployment.',
  },
];
function inputFor(item: Case): Input {
  return {
    currentTime: '2026-11-09T12:00:00.000Z',
    channel: {
      channelId: 'head-eval', title: 'CSV delivery',
      prompt: 'Collaborate using public evidence and your own role. Executor implements; Reviewer independently reviews; Wiki maintains documentation; Issuer tracks progress. Do not repeat completed work or acknowledgements. Reviewed, merged, and deployed are distinct. Respect human restrictions.',
    },
    pet: { participantId: `pet:${item.pet}`, name: item.pet, description: routing.pets[item.pet], document: { missing: true } },
    members, messages: item.messages, history: item.history ?? [],
    execution: item.execution ?? { state: 'unknown' },
  };
}
function checks(item: Case, decision: Decision): string[] {
  const failures: string[] = [];
  if (decision.action !== item.expected) failures.push(`Expected ${item.expected}, received ${decision.action}`);
  if (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) failures.push('Invalid confidence');
  if (typeof decision.reason !== 'string') failures.push('reason must be a string');
  if (typeof decision.reply !== 'string' || typeof decision.focus !== 'string') {
    failures.push('reply/focus must both be strings');
    return failures;
  }
  if (decision.action === 'reply' && !decision.reply.trim()) failures.push('Reply action has no public answer');
  // focus is optional in the production contract; presence is not a quality score.
  if (decision.action === 'skip' && decision.reply.trim()) failures.push('Skip carries a public reply');
  return failures;
}
const requested = process.env.HEAD_EVAL_CASE_IDS?.split(',').map(id => id.trim()).filter(Boolean);
if (requested && (!requested.length || requested.some(id => !cases.some(item => item.id === id)))) {
  throw new Error('HEAD_EVAL_CASE_IDS must contain known, nonempty case IDs.');
}
const selected = requested ? cases.filter(item => requested.includes(item.id)) : cases;
const inputs = new Map(selected.map(item => [item.id, inputFor(item)]));
if (process.env.HEAD_EVAL_LIST_CASES === '1') {
  console.log(JSON.stringify(selected.map(({ id, pet, expected, review }) => ({ id, pet, expected, review })), null, 2));
  process.exit(0);
}
const profileId = process.env.HEAD_EVAL_MODEL_PROFILE_ID ?? process.env.PROMPT_EVAL_MODEL_PROFILE_ID;
if (!profileId?.trim()) throw new Error('Set HEAD_EVAL_MODEL_PROFILE_ID (or PROMPT_EVAL_MODEL_PROFILE_ID) to explicitly opt in to real-model calls.');
const repeats = Number(process.env.HEAD_EVAL_REPEATS ?? 3);
const timeoutMs = Number(process.env.HEAD_EVAL_TIMEOUT_MS ?? 60_000);
if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error('HEAD_EVAL_REPEATS must be a positive integer.');
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('HEAD_EVAL_TIMEOUT_MS must be a positive integer.');
const output = process.env.HEAD_EVAL_OUTPUT_DIR ? resolve(process.env.HEAD_EVAL_OUTPUT_DIR) : undefined;
if (output) {
  mkdirSync(output, { recursive: true, mode: 0o700 });
  chmodSync(output, 0o700);
  if (['rows.jsonl', 'report.json'].some(name => existsSync(resolve(output, name)))) throw new Error('Output already contains results; choose a new HEAD_EVAL_OUTPUT_DIR.');
}
const { profile, config } = readResolvedProfile(profileId, process.env);
const decide = createLlmPetHeadDecider({
  protocol: config.protocol, profileId, baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model,
  structuredOutputMethod: config.structuredOutputMethod ?? 'jsonMode',
  createChatModel: ({ maxOutputTokens, maxRetries, preferDeterministic, streaming, forceChatCompletions }) => buildModel({
    ...config, maxOutputTokens, maxRetries, timeoutMs,
  }, { preferDeterministic, streaming, forceChatCompletions }),
});
type Row = {
  id: string; repeat: number; expected: Decision['action']; input: Input;
  decision: Decision | null; failures: string[]; automatedPassed: boolean;
  semanticReview: string; semanticStatus: 'not-reviewed'; ms: number; error: boolean;
};
const rows: Row[] = [];
const file = output ? openSync(resolve(output, 'rows.jsonl'), 'wx', 0o600) : undefined;
try {
  for (const item of selected) {
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const input = inputs.get(item.id)!;
      const started = performance.now();
      let decision: Decision | null = null;
      let failures: string[];
      let error = false;
      try {
        decision = await decide(input, AbortSignal.timeout(timeoutMs));
        failures = checks(item, decision);
      } catch {
        // Provider errors can contain request credentials or private endpoint URLs.
        // Keep reports safe; diagnose providers separately through the Host.
        error = true;
        failures = ['Model call failed or timed out (provider error details omitted).'];
      }
      const row: Row = {
        id: item.id, repeat, expected: item.expected, input, decision, failures,
        automatedPassed: failures.length === 0, semanticReview: item.review,
        semanticStatus: 'not-reviewed', ms: Math.round(performance.now() - started), error,
      };
      rows.push(row);
      if (file !== undefined) writeFileSync(file, `${JSON.stringify(row)}\n`);
      console.log(JSON.stringify(row));
    }
  }
} finally {
  if (file !== undefined) closeSync(file);
}
const report = {
  scope: 'Synthetic public Timeline, one Head per decision; no dispatch execution or delivery. Automated checks do not assess semantic grounding. All replies and dispatch focuses require review against their rubric.',
  profileId, model: profile.model, repeats, cases: selected.length,
  automatedPassed: rows.filter(row => row.automatedPassed).length, total: rows.length,
  falseActions: rows.filter(row => row.expected === 'skip' && row.decision !== null && row.decision.action !== 'skip').length,
  missedActions: rows.filter(row => row.expected !== 'skip' && row.decision?.action === 'skip').length,
  errors: rows.filter(row => row.error).length,
  semanticStatus: 'not-reviewed', rows,
};
console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
if (output) writeFileSync(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
if (rows.some(row => !row.automatedPassed)) process.exitCode = 1;
