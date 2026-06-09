import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyReviewEffects,
  authorizeToolAction,
  clearToolAuthorizations,
  isToolActionAuthorized,
  readToolAuthorizationMatcher,
  ReviewEffectApplicationError,
} from './review/reviewAuthorizations';
import type { AgentToolkit } from '../../types/toolkit';

test('applyReviewEffects stores policy-derived thread authorization', async () => {
  clearToolAuthorizations('thread-1');
  const toolkits: AgentToolkit[] = [{
    name: 'local',
    description: 'local tools',
    policy: {
      toolReview: {
        run_shell: {
          request: () => null,
          buildAuthorizationMatcher: ({ input }) => ({
            type: 'shell_pattern',
            value: (input as { command: string }).command,
          }),
        },
      },
    },
  }];

  const applied = await applyReviewEffects({
    threadId: 'thread-1',
    pendingAction: {
      actionId: 'pending_action',
      toolName: 'run_shell',
      args: { command: 'git status', cwd: '/repo' },
    },
    effects: [{
      type: 'graph.authorize_tool_action',
      scope: 'thread',
      actionRef: { type: 'pending_action' },
      matcher: { type: 'policy_hook' },
    }],
    toolkits,
    now: () => new Date('2026-06-09T00:00:00.000Z'),
  });

  assert.deepEqual(applied, [{
    threadId: 'thread-1',
    toolName: 'run_shell',
    matcher: { type: 'shell_pattern', value: 'git status' },
    createdAt: '2026-06-09T00:00:00.000Z',
  }]);
  assert.equal(
    isToolActionAuthorized({
      threadId: 'thread-1',
      toolName: 'run_shell',
      args: { command: 'git   status', cwd: '/repo' },
    }),
    true,
  );
  assert.equal(
    isToolActionAuthorized({
      threadId: 'thread-1',
      toolName: 'run_shell',
      args: { command: 'git push', cwd: '/repo' },
    }),
    false,
  );
  clearToolAuthorizations('thread-1');
});

test('readToolAuthorizationMatcher accepts only declared matcher structures', () => {
  assert.deepEqual(
    readToolAuthorizationMatcher({ type: 'shell_pattern', value: ' git   status ' }),
    { type: 'shell_pattern', value: 'git status' },
  );
  assert.deepEqual(
    readToolAuthorizationMatcher({ type: 'exact_args', value: { path: 'README.md' } }),
    { type: 'exact_args', value: { path: 'README.md' } },
  );
  assert.equal(readToolAuthorizationMatcher({ type: 'shell_pattern', value: '   ' }), null);
  assert.equal(readToolAuthorizationMatcher({ type: 'path_glob', value: '*.ts' }), null);
  assert.equal(readToolAuthorizationMatcher({ type: 'exact_args', value: ['README.md'] }), null);
});

test('applyReviewEffects rejects policy hooks that return undeclared matcher structures', async () => {
  const toolkits: AgentToolkit[] = [{
    name: 'local',
    description: 'local tools',
    policy: {
      toolReview: {
        run_shell: {
          request: () => null,
          buildAuthorizationMatcher: () => ({ type: 'path_glob', value: '*.ts' }) as never,
        },
      },
    },
  }];

  await assert.rejects(
    () => applyReviewEffects({
      threadId: 'thread-1',
      pendingAction: {
        actionId: 'pending_action',
        toolName: 'run_shell',
        args: { command: 'git status' },
      },
      effects: [{
        type: 'graph.authorize_tool_action',
        scope: 'thread',
        actionRef: { type: 'pending_action' },
        matcher: { type: 'policy_hook' },
      }],
      toolkits,
    }),
    (error) => error instanceof ReviewEffectApplicationError
      && error.code === 'invalid_matcher',
  );
});

test('authorizeToolAction validates matcher shape before storing state', () => {
  clearToolAuthorizations('thread-2');
  assert.throws(
    () => authorizeToolAction({
      threadId: 'thread-2',
      toolName: 'run_shell',
      matcher: { type: 'shell_pattern', value: '   ' },
    }),
    (error) => error instanceof ReviewEffectApplicationError
      && error.code === 'invalid_matcher',
  );
  assert.equal(
    isToolActionAuthorized({
      threadId: 'thread-2',
      toolName: 'run_shell',
      args: { command: 'git status' },
    }),
    false,
  );
});
