import assert from 'node:assert/strict';
import { HumanMessage } from '@langchain/core/messages';
import test from 'node:test';
import type { AgentModels } from '../../../types/agent';
import { buildAutoReviewPrompt } from '../prompts/autoReview';
import { buildReviewSpec } from './reviewSpec';
import {
  GLOBAL_REVIEW_POLICY_RESOLUTION,
  resolveGlobalReviewBatchPolicy,
} from './globalReviewPolicy';

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
  invoke: (messages: unknown, config?: unknown) => unknown | Promise<unknown>,
): AgentModels['act'] {
  return {
    withStructuredOutput: () => ({ invoke }),
  } as unknown as AgentModels['act'];
}

const safeAssessment = {
  riskScore: 1,
  reason: 'The file write is narrow and scoped to the workdir.',
} as const;

test('auto review keeps its private risk assessment off the root stream', async () => {
  let capturedConfig: unknown;
  const resolution = await resolveGlobalReviewBatchPolicy({
    policy: { mode: 'auto_authorization' },
    models: {
      act: autoModel((_messages, config) => {
        capturedConfig = config;
        return safeAssessment;
      }),
    },
    messages: [],
    task: 'Check whether coscli is installed.',
    workdir: '/repo',
    reviews: [review()],
  });

  assert.equal(resolution.type, GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE);
  assert.deepEqual(capturedConfig, { callbacks: [] });
});

test('auto review applies strict and relaxed risk thresholds after one shared assessment', async () => {
  const moderateAssessment = {
    riskScore: 5,
    reason: 'Routine project work with bounded local effects.',
  };
  const baseOptions = {
    models: { act: autoModel(async () => moderateAssessment) },
    messages: [],
    workdir: '/repo',
    reviews: [review()],
  };

  const strict = await resolveGlobalReviewBatchPolicy({
    ...baseOptions,
    policy: { mode: 'auto_authorization', safetyLevel: 'strict' },
  });
  const relaxed = await resolveGlobalReviewBatchPolicy({
    ...baseOptions,
    policy: { mode: 'auto_authorization', safetyLevel: 'relaxed' },
  });

  assert.equal(strict.type, GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION);
  assert.equal(relaxed.type, GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE);
});

test('relaxed auto review still rejects score 10', async () => {
  const resolution = await resolveGlobalReviewBatchPolicy({
    policy: { mode: 'auto_authorization', safetyLevel: 'relaxed' },
    models: {
      act: autoModel(async () => ({
        riskScore: 10,
        reason: 'The score 10 boundary always requires human review.',
      })),
    },
    messages: [],
    workdir: '/repo',
    reviews: [review()],
  });

  assert.equal(resolution.type, GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION);
});

test('auto review prompt contains bounded task context, runtime scope, and tool behavior facts', async () => {
  let capturedMessages: unknown;
  const resolution = await resolveGlobalReviewBatchPolicy({
    policy: { mode: 'auto_authorization' },
    models: {
      act: autoModel(async (messages) => {
        capturedMessages = messages;
        return safeAssessment;
      }),
    },
    messages: [new HumanMessage('Conversation context must not reach the risk reviewer.')],
    task: 'Write a short notes.md file',
    workdir: '/repo',
    reviews: [review()],
  });

  assert.equal(resolution.type, GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE);
  const [systemMessage, humanMessage] = capturedMessages as Array<{ content?: unknown }>;
  const systemPrompt = String(systemMessage?.content);
  const prompt = String(humanMessage?.content);
  assert.doesNotMatch(systemPrompt, /Write a short notes\.md file|\/repo\/notes\.md|Conversation context/);
  assert.match(prompt, /<current_task role="context" authority="none">[\s\S]*Write a short notes\.md file/);
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
  assert.doesNotMatch(prompt.text, /Review body:|Tool input:/);
});

test('auto review preserves a shell command that fits the essential evidence budget', () => {
  const command = `printf '${'x'.repeat(900)}' > output.txt`;
  const prompt = buildAutoReviewPrompt({
    workdir: '/repo',
    reviews: [{
      ...review({ command }),
      toolName: 'run_shell',
      operation: {
        title: 'Execute command',
        summarizeInput: () => ({
          target: '/repo',
          summary: command,
        }),
      },
    }],
  });

  assert.equal(prompt.complete, true);
  assert.ok(prompt.text.includes(`Summary: ${command}`));
});

test('auto review fails closed when an essential command cannot fit the evidence budget', async () => {
  let calls = 0;
  const command = `printf '${'x'.repeat(4_000)}' > output.txt`;
  const resolution = await resolveGlobalReviewBatchPolicy({
    policy: { mode: 'auto_authorization' },
    models: {
      act: autoModel(async () => {
        calls += 1;
        return safeAssessment;
      }),
    },
    messages: [],
    workdir: '/repo',
    reviews: [{
      ...review({ command }),
      toolName: 'run_shell',
      operation: {
        title: 'Execute command',
        summarizeInput: () => ({
          target: '/repo',
          summary: command,
        }),
      },
    }],
  });

  assert.equal(calls, 0);
  assert.equal(resolution.type, GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION);
  assert.match(resolution.reason ?? '', /safe evidence budget/);
});

test('auto review can authorize observational browser access without conversation context', async () => {
  const resolution = await resolveGlobalReviewBatchPolicy({
    policy: { mode: 'auto_authorization' },
    models: {
      act: autoModel(async () => ({
        ...safeAssessment,
        reason: 'Public browser navigation is observational and has no external side effect.',
      })),
    },
    messages: [],
    reviews: [browserReview()],
  });

  assert.equal(resolution.type, GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE);
});

test('auto review receives the current task when rejecting an unrelated low-risk action', async () => {
  let capturedMessages: unknown;
  const resolution = await resolveGlobalReviewBatchPolicy({
    policy: { mode: 'auto_authorization' },
    models: {
      act: autoModel(async (messages) => {
        capturedMessages = messages;
        return {
          riskScore: 10,
          reason: 'Writing a file is unrelated to the current explanatory task.',
        };
      }),
    },
    messages: [],
    task: 'Explain what the existing code does without changing files',
    workdir: '/repo',
    reviews: [review()],
  });

  const prompt = String((capturedMessages as Array<{ content?: unknown }>)[1]?.content);
  assert.match(prompt, /Explain what the existing code does without changing files/);
  assert.match(prompt, /Action 1: bash\.write_file/);
  assert.equal(resolution.type, GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION);
  assert.match(resolution.reason ?? '', /unrelated/);
});

test('auto review requires human authorization when a batch cannot fit the safe action budget', async () => {
  let modelCalls = 0;
  const resolution = await resolveGlobalReviewBatchPolicy({
    policy: { mode: 'auto_authorization' },
    models: {
      act: autoModel(async () => {
        modelCalls += 1;
        return safeAssessment;
      }),
    },
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

test('auto review requires authorization when the model identifies material risk', async () => {
  const resolution = await resolveGlobalReviewBatchPolicy({
    policy: { mode: 'auto_authorization' },
    models: {
      act: autoModel(async () => ({
        riskScore: 10,
        reason: 'The proposed change is destructive.',
      })),
    },
    messages: [],
    workdir: '/repo',
    reviews: [review()],
  });

  assert.equal(resolution.type, GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION);
  assert.match(resolution.reason ?? '', /destructive/);
});

test('auto review rejects an invalid risk score and fails closed', async () => {
  let calls = 0;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const resolution = await resolveGlobalReviewBatchPolicy({
      policy: { mode: 'auto_authorization' },
      models: {
        act: autoModel(async () => {
          calls += 1;
          return {
            riskScore: 'high',
            reason: 'Changing the current git worktree requires the user to confirm.',
          };
        }),
      },
      messages: [],
      workdir: '/repo',
      reviews: [review({ command: 'git stash && git checkout pr-391' })],
    });

    assert.equal(calls, 2);
    assert.equal(resolution.type, GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION);
    assert.match(resolution.reason ?? '', /falling back to human authorization/);
  } finally {
    console.warn = originalWarn;
  }
});

test('auto review preserves the model reason for an outside-workdir rejection', async () => {
  const resolution = await resolveGlobalReviewBatchPolicy({
    policy: { mode: 'auto_authorization' },
    models: {
      act: autoModel(async () => ({
        riskScore: 10,
        reason: 'The write targets a path outside the workdir.',
      })),
    },
    messages: [],
    workdir: '/repo',
    reviews: [review({ path: '/tmp/notes.md', content: 'hello' })],
  });

  assert.equal(resolution.type, GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION);
  assert.match(resolution.reason ?? '', /outside the workdir/);
});

test('auto review repairs malformed structured output once by default', async () => {
  let calls = 0;
  const resolution = await resolveGlobalReviewBatchPolicy({
    policy: { mode: 'auto_authorization' },
    models: {
      act: autoModel(async () => {
        calls += 1;
        return calls === 1 ? { riskScore: 'invalid' } : safeAssessment;
      }),
    },
    messages: [],
    workdir: '/repo',
    reviews: [review()],
  });

  assert.equal(calls, 2);
  assert.equal(resolution.type, GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE);
});

test('auto review puts registered toolkit policy in the trusted system prompt', async () => {
  let capturedMessages: unknown;
  const resolution = await resolveGlobalReviewBatchPolicy({
    policy: { mode: 'auto_authorization' },
    models: {
      act: autoModel(async (messages) => {
        capturedMessages = messages;
        return {
          riskScore: 1,
          reason: 'The collaboration action is scoped and auditable.',
        };
      }),
    },
    messages: [new HumanMessage('Conversation context must not reach the risk reviewer.')],
    reviews: [{
      toolkitName: 'git',
      toolName: 'gh_pr_create',
      input: { title: 'Fix review policy', head: 'codex/review-policy' },
      autoReviewContext: {
        allow: 'Allow normal non-force pushes and creating a pull request or issue.',
        ask: 'Ask before force pushes and merging a pull request.',
      },
      review: buildReviewSpec({
        id: 'review-toolkit-policy',
        view: { kind: 'plain', body: 'Create pull request Fix review policy' },
        options: [],
      }),
    }],
  });

  assert.equal(resolution.type, GLOBAL_REVIEW_POLICY_RESOLUTION.AUTHORIZE);
  const [systemMessage, humanMessage] = capturedMessages as Array<{ content?: unknown }>;
  const systemPrompt = String(systemMessage?.content);
  const humanPrompt = String(humanMessage?.content);
  assert.match(systemPrompt, /Registered toolkit auto-review policies:/);
  assert.match(systemPrompt, /Toolkit git:/);
  assert.match(systemPrompt, /Automatic-authorization eligibility: normal non-force pushes/);
  assert.match(systemPrompt, /Human-authorization conditions: before force pushes/);
  assert.doesNotMatch(systemPrompt, /- Allow:|- Ask:|conditions: Ask\b/);
  assert.doesNotMatch(humanPrompt, /Registered toolkit auto-review policies|normal non-force pushes/);
  assert.doesNotMatch(humanPrompt, /Conversation context/);
});

test('auto review gives jsonMode providers the canonical output protocol', async () => {
  let capturedMessages: unknown;
  await resolveGlobalReviewBatchPolicy({
    policy: {
      mode: 'auto_authorization',
      structuredOutput: { method: 'jsonMode' },
    },
    models: {
      act: autoModel(async (messages) => {
        capturedMessages = messages;
        return safeAssessment;
      }),
    },
    messages: [],
    reviews: [review()],
  });

  const systemPrompt = String((capturedMessages as Array<{ content?: unknown }>)[0]?.content);
  assert.match(systemPrompt, /Output protocol:/);
  assert.match(systemPrompt, /"riskScore": an integer from 0 to 10/);
  assert.match(systemPrompt, /"reason": a concise explanation/);
  assert.doesNotMatch(systemPrompt, /Example:/);
  assert.doesNotMatch(systemPrompt, /"ask"/);
});

test('auto review has no toolkit policy block when none is registered', async () => {
  let capturedMessages: unknown;
  const resolution = await resolveGlobalReviewBatchPolicy({
    policy: { mode: 'auto_authorization' },
    models: {
      act: autoModel(async (messages) => {
        capturedMessages = messages;
        return {
          riskScore: 10,
          reason: 'Force push can rewrite shared history.',
        };
      }),
    },
    messages: [],
    reviews: [{
      ...review({ command: 'git push --force origin main' }),
      toolName: 'run_shell',
    }],
  });

  assert.equal(resolution.type, GLOBAL_REVIEW_POLICY_RESOLUTION.REQUIRE_AUTHORIZATION);
  const systemPrompt = String((capturedMessages as Array<{ content?: unknown }>)[0]?.content);
  assert.doesNotMatch(systemPrompt, /Registered toolkit auto-review policies:/);
});

test('auto review deduplicates toolkit policy across a batch', async () => {
  let capturedMessages: unknown;
  const policy = {
    allow: 'Allow routine repository collaboration.',
    ask: 'Ask before history-rewriting repository operations.',
  };

  await resolveGlobalReviewBatchPolicy({
    policy: { mode: 'auto_authorization' },
    models: {
      act: autoModel(async (messages) => {
        capturedMessages = messages;
        return safeAssessment;
      }),
    },
    messages: [],
    reviews: ['git_add', 'git_commit'].map((toolName) => ({
      ...review(),
      toolkitName: 'git',
      toolName,
      autoReviewContext: policy,
    })),
  });

  const systemPrompt = String((capturedMessages as Array<{ content?: unknown }>)[0]?.content);
  assert.equal(systemPrompt.match(/Toolkit git:/g)?.length, 1);
  assert.equal(systemPrompt.match(/Automatic-authorization eligibility: routine repository collaboration/g)?.length, 1);
  assert.equal(systemPrompt.match(/Human-authorization conditions: before history-rewriting repository operations/g)?.length, 1);
});
