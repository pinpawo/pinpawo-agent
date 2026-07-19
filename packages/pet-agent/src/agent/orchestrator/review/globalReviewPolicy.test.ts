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

function browserReview() {
  return {
    toolkitName: 'browser',
    toolName: 'navigate',
    input: { url: 'https://example.com/docs' },
    operation: {
      title: 'Open page',
      summarizeInput: () => ({
        target: 'https://example.com/docs',
        summary: 'Navigate to a public web page',
      }),
    },
    review: buildReviewSpec({
      view: { kind: 'plain' as const, title: 'Open page', body: 'Open example.com/docs' },
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
  scope_assessment: 'workdir',
  risk_factors: [],
  reason: 'The file write is narrow and scoped to the workdir.',
  concerns: [],
  confidence: 'high',
} as const;

test('auto review prompt contains only runtime scope and tool behavior facts', async () => {
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
    messages: [new HumanMessage('Conversation context must not reach the risk reviewer.')],
    workdir: '/repo',
    reviews: [review()],
  });

  assert.equal(resolution.type, GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE);
  const [systemMessage, humanMessage] = capturedMessages as Array<{ content?: unknown }>;
  const systemPrompt = String(systemMessage?.content);
  const prompt = String(humanMessage?.content);
  assert.match(systemPrompt, /fallback risk review/);
  assert.match(systemPrompt, /concrete behavior and effects of the proposed tools/);
  assert.match(systemPrompt, /Ordinary browser navigation or public HTTP\(S\) retrieval is usually low risk/);
  assert.match(systemPrompt, /files inside the effective workdir is usually low risk/);
  assert.match(prompt, /<workdir authority="runtime">[\s\S]*\/repo/);
  assert.match(prompt, /Action 1: bash\.write_file/);
  assert.match(prompt, /Target: \/repo\/notes\.md/);
  assert.match(prompt, /Input facts:[\s\S]*"path": "notes\.md"/);
  assert.doesNotMatch(prompt, /Conversation context/);
  assert.doesNotMatch(prompt, /user_requests|derived_task|Decision policy:/);
});

test('auto review prompt stays compact and keeps every action identity', () => {
  const reviews = Array.from({ length: 6 }, (_, index) => ({
    ...review({ path: `file-${index + 1}.txt`, content: 'x'.repeat(20_000) }),
    toolName: `write_file_${index + 1}`,
  }));
  const prompt = buildAutoReviewPrompt({
    workdir: '/repo',
    reviews,
  });

  assert.equal(prompt.complete, true);
  assert.ok(prompt.text.length <= 8_000);
  for (let index = 1; index <= 6; index += 1) {
    assert.match(prompt.text, new RegExp(`write_file_${index}`));
  }
  assert.doesNotMatch(prompt.text, /x{100}/);
  assert.doesNotMatch(prompt.text, /Review body:|Tool input:/);
});

test('auto review can authorize observational browser access without conversation context', async () => {
  const resolution = await resolveGlobalReviewBatchPolicy({
    policy: { mode: 'auto_authorization' },
    models: {
      act: autoModel(async () => ({
        ...safeDecision,
        scope_assessment: 'external_service',
        reason: 'Public browser navigation is observational and has no external side effect.',
      })),
    },
    actor: testActor,
    messages: [],
    reviews: [browserReview()],
  });

  assert.equal(resolution.type, GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE);
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
    messages: [],
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
    messages: [],
    workdir: '/repo',
    reviews: [review()],
  });

  assert.equal(resolution.type, GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION);
  assert.match(resolution.reason ?? '', /inconsistent or low-confidence/);
});

test('auto review rejects an approval that reports risk factors', async () => {
  const resolution = await resolveGlobalReviewBatchPolicy({
    policy: { mode: 'auto_authorization' },
    models: {
      act: autoModel(async () => ({
        ...safeDecision,
        risk_factors: ['destructive_change'],
      })),
    },
    actor: testActor,
    messages: [],
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
        risk_factors: ['outside_workdir'],
      })),
    },
    actor: testActor,
    messages: [],
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
    messages: [],
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
    messages: [],
    workdir: '/repo',
    reviews: [review()],
  });

  assert.equal(calls, 2);
  assert.equal(resolution.type, GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE);
});
