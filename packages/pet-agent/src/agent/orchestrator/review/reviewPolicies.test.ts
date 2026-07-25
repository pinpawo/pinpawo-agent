import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ToolAuthorizationMatcherContext,
  ToolReviewContext,
} from '../../../types/toolkit';
import { authorizeToolAction } from './reviewAuthorizations';
import { ReviewPolicies } from './reviewPolicies';

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

function matcherContext(overrides: Partial<ToolAuthorizationMatcherContext> = {}): ToolAuthorizationMatcherContext {
  return {
    toolkitName: 'local',
    toolName: 'write_file',
    input: { path: 'notes.md', content: 'hello' },
    operation: reviewContext().operation,
    pendingAction: {
      actionId: 'call-1',
      toolName: 'write_file',
      args: { path: 'notes.md', content: 'hello' },
    },
    effect: {
      type: 'graph.authorize_tool_action',
      scope: 'thread',
      actionRef: { type: 'pending_action' },
      matcher: { type: 'policy_hook' },
    },
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

test('presets can opt into exact args authorization', async () => {
  const policy = ReviewPolicies.localMutation({ authorization: 'exact_args' });
  const matcher = await policy.buildAuthorizationMatcher?.(matcherContext());
  assert.deepEqual(matcher, {
    type: 'exact_args',
    value: { path: 'notes.md', content: 'hello' },
  });

  const review = await policy.request(reviewContext({
    toolAuthorizations: [authorizeToolAction({
      toolName: 'write_file',
      matcher: matcher!,
      now: () => new Date('2026-06-15T00:00:00.000Z'),
    })],
  }));

  assert.equal(review, null);
});

test('externalAccess can opt into URL domain authorization', async () => {
  const policy = ReviewPolicies.externalAccess({ authorization: 'url_domain' });
  const matcher = await policy.buildAuthorizationMatcher?.(matcherContext({
    toolName: 'browser_open',
    input: { url: 'https://Example.test/a', headless: true },
    pendingAction: {
      actionId: 'call-1',
      toolName: 'browser_open',
      args: { url: 'https://Example.test/a', headless: true },
    },
  }));
  assert.deepEqual(matcher, {
    type: 'url_domain',
    value: { origin: 'https://example.test' },
  });

  const review = await policy.request(reviewContext({
    toolName: 'browser_open',
    input: { url: 'https://example.test/b', headless: false },
    toolAuthorizations: [authorizeToolAction({
      toolName: 'browser_open',
      matcher: matcher!,
      now: () => new Date('2026-06-15T00:00:00.000Z'),
    })],
  }));

  assert.equal(review, null);
});

test('URL domain authorization option uses domain-specific description', async () => {
  const policy = ReviewPolicies.externalAccess({ authorization: 'url_domain' });

  const review = await policy.request(reviewContext({
    toolName: 'browser_open',
    input: { url: 'https://example.test/a', headless: true },
  }));

  const authorizeOption = review && 'schemaVersion' in review
    ? review.options.find((option) => option.id === 'approve-and-authorize-thread')
    : null;
  assert.equal(
    authorizeOption?.description,
    'Approve this action and authorize the same URL domain in this thread.',
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

  const review = await policy.request(reviewContext());

  assert.equal(review, null);
});
