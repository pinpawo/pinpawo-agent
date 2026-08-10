import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ToolAuthorizationContext,
  ToolReviewContext,
} from '../../../types/toolkit';
import {
  AuthorizationPolicies,
  ReviewPolicies,
} from './reviewPolicies';

function reviewContext(overrides: Partial<ToolReviewContext> = {}): ToolReviewContext {
  return {
    toolkitName: 'local',
    toolName: 'write_file',
    input: { path: 'notes.md', content: 'hello' },
    reviewCapabilities: {
      humanReview: true,
      sessionAuthorization: true,
    },
    operation: {
      title: '写文件',
      summarizeInput: () => ({
        target: '/repo/notes.md',
        summary: 'write',
        details: { createDirs: true },
      }),
    },
    ...overrides,
  };
}

function authorizationContext(
  overrides: Partial<ToolAuthorizationContext> = {},
): ToolAuthorizationContext {
  return {
    toolkitName: 'local',
    toolName: 'write_file',
    input: { path: 'notes.md', content: 'hello' },
    operation: reviewContext().operation,
    ...overrides,
  };
}

test('localMutation builds ReviewSpec from operation metadata', async () => {
  const policy = ReviewPolicies.localMutation();

  const review = await policy.request(reviewContext());

  const view = review && 'schemaVersion' in review ? review.view : null;
  assert.ok(view && view.kind === 'plain');
  assert.equal(view.title, '写文件');
  assert.match(view.body, /Target: \/repo\/notes\.md/);
  assert.match(view.body, /createDirs/);
  assert.deepEqual(
    review && 'schemaVersion' in review ? review.options.map((option) => option.id) : [],
    ['approve', 'reject', 'respond'],
  );
});

test('presets can opt into exact authorization without retaining raw input', async () => {
  const policy = ReviewPolicies.localMutation({ authorization: 'exact' });
  const buildMatcher = policy.authorization?.buildMatcher;
  assert.ok(buildMatcher);
  const matcher = await buildMatcher(authorizationContext());
  assert.equal(matcher?.type, 'exact');
  assert.match(
    matcher?.type === 'exact' ? matcher.key : '',
    /^exact:v1:sha256:[a-f0-9]{64}$/,
  );
  assert.doesNotMatch(JSON.stringify(matcher), /notes\.md|hello/);

  const review = await policy.request(reviewContext({
    authorizationMatcher: matcher,
  }));
  assert.deepEqual(
    review && 'schemaVersion' in review ? review.options.map((option) => option.id) : [],
    ['approve', 'approve-and-authorize-thread', 'reject', 'respond'],
  );
});

test('exact authorization supports a tool-owned minimal subject', async () => {
  const policy = ReviewPolicies.commandExecution({
    authorization: AuthorizationPolicies.exact({
      subject: ({ input }) => {
        const command = input as {
          command: string;
          cwd: string;
          timeoutSeconds?: number;
        };
        return {
          command: command.command,
          cwd: command.cwd,
        };
      },
    }),
  });
  const buildMatcher = policy.authorization?.buildMatcher;
  assert.ok(buildMatcher);
  const first = await buildMatcher(authorizationContext({
    toolName: 'run_shell',
    input: { command: 'npm test', cwd: '/repo', timeoutSeconds: 60 },
  }));
  const changedTimeout = await buildMatcher(authorizationContext({
    toolName: 'run_shell',
    input: { command: 'npm test', cwd: '/repo', timeoutSeconds: 300 },
  }));
  const changedCwd = await buildMatcher(authorizationContext({
    toolName: 'run_shell',
    input: { command: 'npm test', cwd: '/other', timeoutSeconds: 60 },
  }));

  assert.deepEqual(first, changedTimeout);
  assert.notDeepEqual(first, changedCwd);
});

test('externalAccess can opt into URL origin authorization', async () => {
  const policy = ReviewPolicies.externalAccess({ authorization: 'url_origin' });
  const buildMatcher = policy.authorization?.buildMatcher;
  assert.ok(buildMatcher);
  const matcher = await buildMatcher(authorizationContext({
    toolName: 'browser_open',
    input: { url: 'https://Example.test/a', headless: true },
  }));
  assert.deepEqual(matcher, {
    type: 'url_origin',
    origin: 'https://example.test',
  });

  const review = await policy.request(reviewContext({
    toolName: 'browser_open',
    input: { url: 'https://example.test/b', headless: false },
    authorizationMatcher: matcher,
  }));
  const authorizeOption = review && 'schemaVersion' in review
    ? review.options.find((option) => option.id === 'approve-and-authorize-thread')
    : null;
  assert.equal(
    authorizeOption?.description,
    'Approve this action and authorize the same URL domain in this thread.',
  );
});

test('a null matcher does not expose approve-and-authorize', async () => {
  const policy = ReviewPolicies.localMutation({
    authorization: AuthorizationPolicies.exact({
      subject: () => null,
    }),
  });
  const buildMatcher = policy.authorization?.buildMatcher;
  assert.ok(buildMatcher);
  const matcher = await buildMatcher(authorizationContext());
  const review = await policy.request(reviewContext({
    authorizationMatcher: matcher,
  }));

  assert.equal(matcher, null);
  assert.deepEqual(
    review && 'schemaVersion' in review ? review.options.map((option) => option.id) : [],
    ['approve', 'reject', 'respond'],
  );
});

test('commandExecution requires HITL once configured', async () => {
  const policy = ReviewPolicies.commandExecution();

  const review = await policy.request(reviewContext({
    toolName: 'run_shell',
    input: { command: 'pwd' },
    operation: {
      title: '执行命令',
      summarizeInput: () => ({ summary: 'pwd' }),
    },
  }));

  assert.equal(review && 'schemaVersion' in review ? review.view.title : null, '执行命令');
  assert.deepEqual(
    review && 'schemaVersion' in review ? review.options.map((option) => option.id) : [],
    ['approve', 'reject', 'respond'],
  );
});

test('localMutation blocks when HITL is unavailable by default', async () => {
  const policy = ReviewPolicies.localMutation();

  const review = await policy.request(reviewContext({
    reviewCapabilities: {
      humanReview: false,
      sessionAuthorization: false,
    },
  }));

  assert.deepEqual(review, {
    type: 'block',
    reason: 'Human review is required before running write_file, but this runtime does not support HITL.',
  });
});

test('never leaves tool calls unaffected', async () => {
  const policy = ReviewPolicies.never();
  assert.equal(await policy.request(reviewContext()), null);
});
