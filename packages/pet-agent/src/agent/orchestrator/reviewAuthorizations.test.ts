import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyReviewEffects,
  authorizeToolAction,
  isToolActionAuthorized,
  mergeToolAuthorizations,
  readToolAuthorizationMatcher,
  ReviewEffectApplicationError,
} from './review/reviewAuthorizations';
import type { AgentToolkit, NamedStructuredTool } from '../../types/toolkit';

const runShellTool = { name: 'run_shell' } as NamedStructuredTool<'run_shell'>;

test('applyReviewEffects builds policy-derived authorization records', async () => {
  const toolkits: AgentToolkit[] = [{
    name: 'local',
    description: 'local tools',
    tools: [{
      tool: runShellTool,
      review: {
          request: () => null,
          buildAuthorizationMatcher: ({ input }) => ({
            type: 'shell_pattern',
            value: (input as { command: string }).command,
          }),
      },
    }],
  }];

  const applied = await applyReviewEffects({
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
    toolName: 'run_shell',
    matcher: { type: 'shell_pattern', value: 'git status' },
    createdAt: '2026-06-09T00:00:00.000Z',
    source: 'human',
  }]);
  assert.equal(
    isToolActionAuthorized({
      authorizations: applied,
      toolName: 'run_shell',
      args: { command: 'git   status', cwd: '/repo' },
    }),
    true,
  );
  assert.equal(
    isToolActionAuthorized({
      authorizations: applied,
      toolName: 'run_shell',
      args: { command: 'git push', cwd: '/repo' },
    }),
    false,
  );
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
  assert.deepEqual(
    readToolAuthorizationMatcher({ type: 'url_domain', value: { origin: 'HTTPS://Example.test:443/a' } }),
    { type: 'url_domain', value: { origin: 'https://example.test' } },
  );
  assert.equal(readToolAuthorizationMatcher({ type: 'shell_pattern', value: '   ' }), null);
  assert.equal(readToolAuthorizationMatcher({ type: 'path_glob', value: '*.ts' }), null);
  assert.equal(readToolAuthorizationMatcher({ type: 'exact_args', value: ['README.md'] }), null);
  assert.equal(readToolAuthorizationMatcher({ type: 'url_domain', value: { origin: 'not a url' } }), null);
});

test('url domain authorizations match the same URL origin only', () => {
  const authorizations = [authorizeToolAction({
    toolName: 'browser_open',
    matcher: { type: 'url_domain', value: { origin: 'https://example.test' } },
  })];

  assert.equal(
    isToolActionAuthorized({
      authorizations,
      toolName: 'browser_open',
      args: { url: 'https://example.test/a', headless: true },
    }),
    true,
  );
  assert.equal(
    isToolActionAuthorized({
      authorizations,
      toolName: 'browser_open',
      args: { url: 'https://example.test/b', headless: false },
    }),
    true,
  );
  assert.equal(
    isToolActionAuthorized({
      authorizations,
      toolName: 'browser_open',
      args: { url: 'http://example.test/a', headless: true },
    }),
    false,
  );
  assert.equal(
    isToolActionAuthorized({
      authorizations,
      toolName: 'browser_open_with_session',
      args: { url: 'https://example.test/a', session: 'work' },
    }),
    false,
  );
});

test('applyReviewEffects rejects policy hooks that return undeclared matcher structures', async () => {
  const toolkits: AgentToolkit[] = [{
    name: 'local',
    description: 'local tools',
    tools: [{
      tool: runShellTool,
      review: {
          request: () => null,
          buildAuthorizationMatcher: () => ({ type: 'path_glob', value: '*.ts' }) as never,
      },
    }],
  }];

  await assert.rejects(
    () => applyReviewEffects({
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
  assert.throws(
    () => authorizeToolAction({
      toolName: 'run_shell',
      matcher: { type: 'shell_pattern', value: '   ' },
    }),
    (error) => error instanceof ReviewEffectApplicationError
      && error.code === 'invalid_matcher',
  );
  assert.equal(
    isToolActionAuthorized({
      authorizations: [],
      toolName: 'run_shell',
      args: { command: 'git status' },
    }),
    false,
  );
});

test('mergeToolAuthorizations appends unique records and dedupes matcher keys', () => {
  const merged = mergeToolAuthorizations(
    [{
      toolName: 'run_shell',
      matcher: { type: 'shell_pattern', value: ' git   status ' },
      createdAt: '2026-06-09T00:00:00.000Z',
    }],
    [
      {
        toolName: 'run_shell',
        matcher: { type: 'shell_pattern', value: 'git status' },
        createdAt: '2026-06-09T00:00:01.000Z',
      },
      {
        toolName: 'run_shell',
        matcher: { type: 'shell_pattern', value: 'git push' },
        createdAt: '2026-06-09T00:00:02.000Z',
      },
      {
        toolName: 'read_file',
        matcher: { type: 'exact_args', value: { path: 'README.md' } },
        createdAt: '2026-06-09T00:00:03.000Z',
      },
    ],
  );

  assert.deepEqual(merged, [
    {
      toolName: 'run_shell',
      matcher: { type: 'shell_pattern', value: 'git status' },
      createdAt: '2026-06-09T00:00:00.000Z',
    },
    {
      toolName: 'run_shell',
      matcher: { type: 'shell_pattern', value: 'git push' },
      createdAt: '2026-06-09T00:00:02.000Z',
    },
    {
      toolName: 'read_file',
      matcher: { type: 'exact_args', value: { path: 'README.md' } },
      createdAt: '2026-06-09T00:00:03.000Z',
    },
  ]);
});

test('mergeToolAuthorizations upgrades an auto-review grant to a human grant', () => {
  const matcher = { type: 'exact_args' as const, value: { command: 'npm test' } };
  const merged = mergeToolAuthorizations(
    [{
      toolName: 'run_shell',
      matcher,
      createdAt: '2026-07-29T00:00:00.000Z',
      source: 'auto_review',
    }],
    [{
      toolName: 'run_shell',
      matcher,
      createdAt: '2026-07-29T00:01:00.000Z',
      source: 'human',
    }],
  );

  assert.deepEqual(merged, [{
    toolName: 'run_shell',
    matcher,
    createdAt: '2026-07-29T00:01:00.000Z',
    source: 'human',
  }]);
});
