import assert from 'node:assert/strict';
import { HumanMessage } from '@langchain/core/messages';
import test from 'node:test';
import type { AgentActor, AgentModels } from '../../../types/agent';
import { buildAutoReviewPrompt } from '../prompts/autoReview';
import { buildReviewSpec } from './reviewSpec';
import {
  GLOBAL_REVIEW_POLICY_RESOLUTION,
  resolveGlobalReviewBatchPolicy,
} from './globalReviewPolicy';

const testActor = {
  petId: 'pet-1',
  userId: 'user-1',
  name: 'Test actor',
  personality: null,
  stage: null,
  species: null,
} satisfies AgentActor;

function review(input: Record<string, unknown> = { path: 'notes.md', content: 'hello' }) {
  return {
    toolkitName: 'bash',
    toolName: 'write_file',
    input,
    operation: {
      title: 'Write file',
      summarizeInput: () => ({
        target: '/repo/notes.md',
        summary: 'write',
      }),
    },
    review: buildReviewSpec({
      view: { kind: 'plain' as const, title: 'Write file', body: 'Write /repo/notes.md' },
      options: [],
    }),
  };
}

function autoModel(
  invoke: (messages: unknown) => unknown | Promise<unknown>,
): AgentModels['act'] {
  return {
    withStructuredOutput: () => ({ invoke }),
  } as unknown as AgentModels['act'];
}

const safeDecision = {
  decision: 'authorize',
  risk_level: 'low',
  intent_alignment: 'explicit',
  scope_assessment: 'workdir',
  reason: 'The requested file write is scoped to the workdir.',
  concerns: [],
  confidence: 'high',
} as const;

test('auto review prompt preserves user intent, current task, and runtime scope', async () => {
  let capturedMessages: unknown;
  const resolution = await resolveGlobalReviewBatchPolicy({
    policy: { mode: 'auto_authorization' },
    models: {
      act: autoModel(async (messages) => {
        capturedMessages = messages;
        return safeDecision;
      }),
    },
    actor: testActor,
    messages: [new HumanMessage('This transport context is not reviewer evidence.')],
    userRequests: ['Create a short notes.md file in this repository.'],
    task: 'Create the requested notes file',
    workdir: '/repo',
    reviews: [review()],
  });

  assert.equal(resolution.type, GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE);
  const [systemMessage, humanMessage] = capturedMessages as Array<{ content?: unknown }>;
  const systemPrompt = String(systemMessage?.content);
  const prompt = String(humanMessage?.content);
  assert.match(systemPrompt, /Only user_requests records original user authorization intent/);
  assert.match(systemPrompt, /Decision policy:/);
  assert.match(systemPrompt, /Ordinary browser navigation or public HTTP\(S\) retrieval is usually low risk/);
  assert.match(systemPrompt, /Creating or editing files inside the effective workdir is usually low risk/);
  assert.match(prompt, /<derived_task authority="none">[\s\S]*Create the requested notes file/);
  assert.match(prompt, /<workdir authority="runtime">[\s\S]*\/repo/);
  assert.match(prompt, /<user_requests authority="user">/);
  assert.match(prompt, /Create a short notes\.md file/);
  assert.match(prompt, /Target: \/repo\/notes\.md/);
  assert.doesNotMatch(prompt, /transport context/);
  assert.doesNotMatch(prompt, /Decision policy:/);
});

test('auto review prompt stays compact and keeps every action identity', () => {
  const reviews = Array.from({ length: 6 }, (_, index) => ({
    ...review({ path: `file-${index + 1}.txt`, content: 'x'.repeat(20_000) }),
    toolName: `write_file_${index + 1}`,
  }));
  const prompt = buildAutoReviewPrompt({
    userRequests: ['Write the six requested files'],
    task: 'Write six files',
    workdir: '/repo',
    reviews,
  });

  assert.equal(prompt.complete, true);
  assert.ok(prompt.text.length <= 8_000);
  for (let index = 1; index <= 6; index += 1) {
    assert.match(prompt.text, new RegExp(`write_file_${index}`));
  }
  assert.doesNotMatch(prompt.text, /x{100}/);
  assert.doesNotMatch(prompt.text, /Review body:/);
  assert.doesNotMatch(prompt.text, /Tool input:/);
});

test('auto review requires human authorization when a batch cannot fit the safe action budget', async () => {
  let modelCalls = 0;
  const resolution = await resolveGlobalReviewBatchPolicy({
    policy: { mode: 'auto_authorization' },
    models: {
      act: autoModel(async () => {
        modelCalls += 1;
        return safeDecision;
      }),
    },
    actor: testActor,
    messages: [new HumanMessage('Perform all requested actions')],
    userRequests: ['Perform all requested actions'],
    task: 'Perform seven actions',
    workdir: '/repo',
    reviews: Array.from({ length: 7 }, (_, index) => ({
      ...review(),
      toolName: `write_file_${index + 1}`,
    })),
  });

  assert.equal(modelCalls, 0);
  assert.equal(resolution.type, GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION);
  assert.match(resolution.reason ?? '', /safe evidence budget/);
});

test('auto review requires human authorization without original user intent', async () => {
  let modelCalls = 0;
  const resolution = await resolveGlobalReviewBatchPolicy({
    policy: { mode: 'auto_authorization' },
    models: {
      act: autoModel(async () => {
        modelCalls += 1;
        return safeDecision;
      }),
    },
    actor: testActor,
    messages: [new HumanMessage('Transport-only context')],
    task: 'Write notes.md',
    workdir: '/repo',
    reviews: [review()],
  });

  assert.equal(modelCalls, 0);
  assert.equal(resolution.type, GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION);
  assert.match(resolution.reason ?? '', /no original user request/);
});

test('auto review requires human authorization when user intent would be truncated', async () => {
  let modelCalls = 0;
  const resolution = await resolveGlobalReviewBatchPolicy({
    policy: { mode: 'auto_authorization' },
    models: {
      act: autoModel(async () => {
        modelCalls += 1;
        return safeDecision;
      }),
    },
    actor: testActor,
    messages: [new HumanMessage('Transport-only context')],
    userRequests: [`Write notes.md ${'with details '.repeat(80)}`],
    task: 'Write notes.md',
    workdir: '/repo',
    reviews: [review()],
  });

  assert.equal(modelCalls, 0);
  assert.equal(resolution.type, GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION);
  assert.match(resolution.reason ?? '', /safe evidence budget/);
});

test('auto review rejects an internally inconsistent approval', async () => {
  const resolution = await resolveGlobalReviewBatchPolicy({
    policy: { mode: 'auto_authorization' },
    models: {
      act: autoModel(async () => ({
        ...safeDecision,
        risk_level: 'medium',
        confidence: 'low',
      })),
    },
    actor: testActor,
    messages: [new HumanMessage('Write the file')],
    userRequests: ['Write the file'],
    task: 'Write the file',
    workdir: '/repo',
    reviews: [review()],
  });

  assert.equal(resolution.type, GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION);
  assert.match(resolution.reason ?? '', /inconsistent or low-confidence/);
});

test('auto review rejects model approval for an outside-workdir scope', async () => {
  const resolution = await resolveGlobalReviewBatchPolicy({
    policy: { mode: 'auto_authorization' },
    models: {
      act: autoModel(async () => ({
        ...safeDecision,
        scope_assessment: 'outside_workdir',
      })),
    },
    actor: testActor,
    messages: [new HumanMessage('Write the file')],
    userRequests: ['Write the file'],
    task: 'Write the file',
    workdir: '/repo',
    reviews: [review({ path: '/tmp/notes.md', content: 'hello' })],
  });

  assert.equal(resolution.type, GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION);
});

test('auto review rejects a workdir-scoped approval when no workdir is known', async () => {
  const resolution = await resolveGlobalReviewBatchPolicy({
    policy: { mode: 'auto_authorization' },
    models: { act: autoModel(async () => safeDecision) },
    actor: testActor,
    messages: [new HumanMessage('Write the file')],
    userRequests: ['Write the file'],
    task: 'Write the file',
    reviews: [review()],
  });

  assert.equal(resolution.type, GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION);
  assert.match(resolution.reason ?? '', /inconsistent or low-confidence/);
});

test('auto review repairs malformed structured output once by default', async () => {
  let calls = 0;
  const resolution = await resolveGlobalReviewBatchPolicy({
    policy: { mode: 'auto_authorization' },
    models: {
      act: autoModel(async () => {
        calls += 1;
        return calls === 1 ? { decision: 'authorize' } : safeDecision;
      }),
    },
    actor: testActor,
    messages: [new HumanMessage('Write notes.md')],
    userRequests: ['Write notes.md'],
    task: 'Write notes.md',
    workdir: '/repo',
    reviews: [review()],
  });

  assert.equal(calls, 2);
  assert.equal(resolution.type, GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE);
});
