import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyReviewEffects,
  authorizeToolAction,
  exactAuthorization,
  isToolActionAuthorized,
  mergeToolAuthorizations,
  readToolAuthorizationMatcher,
  ReviewEffectApplicationError,
  urlOriginAuthorization,
} from './review/reviewAuthorizations';

test('exactAuthorization recursively canonicalizes objects while preserving array order', () => {
  const first = exactAuthorization({
    argv: ['kubectl', 'get', 'pods'],
    options: { namespace: 'production', output: 'json' },
  });
  const reordered = exactAuthorization({
    options: { output: 'json', namespace: 'production' },
    argv: ['kubectl', 'get', 'pods'],
  });
  const differentArgv = exactAuthorization({
    argv: ['kubectl', 'get', 'services'],
    options: { namespace: 'production', output: 'json' },
  });

  assert.deepEqual(first, reordered);
  assert.notDeepEqual(first, differentArgv);
  assert.equal(first.type, 'exact');
  assert.match(first.type === 'exact' ? first.key : '', /^exact:v1:sha256:[a-f0-9]{64}$/);
});

test('exactAuthorization rejects non-JSON and circular subjects', () => {
  assert.throws(
    () => exactAuthorization({ timeout: Number.POSITIVE_INFINITY }),
    /non-finite numbers/,
  );
  assert.throws(
    () => exactAuthorization({ createdAt: new Date() }),
    /only JSON values/,
  );
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(
    () => exactAuthorization(circular),
    /circular references/,
  );
});

test('applyReviewEffects stores the prepared matcher as a human grant', async () => {
  const matcher = exactAuthorization({
    argv: ['git', 'status'],
    cwd: '/repo',
  });
  const applied = await applyReviewEffects({
    toolName: 'run_process',
    matcher,
    effects: [{
      type: 'graph.authorize_tool_action',
      scope: 'thread',
    }],
    now: () => new Date('2026-06-09T00:00:00.000Z'),
  });

  assert.deepEqual(applied, [{
    toolName: 'run_process',
    matcher,
    createdAt: '2026-06-09T00:00:00.000Z',
    source: 'human',
  }]);
});

test('readToolAuthorizationMatcher accepts only converged matcher structures', () => {
  const exact = exactAuthorization({ path: 'README.md' });
  assert.deepEqual(readToolAuthorizationMatcher(exact), exact);
  assert.deepEqual(
    readToolAuthorizationMatcher({
      type: 'url_origin',
      origin: 'HTTPS://Example.test:443/a',
    }),
    { type: 'url_origin', origin: 'https://example.test' },
  );
  assert.equal(
    readToolAuthorizationMatcher({ type: 'exact_args', value: { path: 'README.md' } }),
    null,
  );
  assert.equal(
    readToolAuthorizationMatcher({ type: 'shell_pattern', value: 'git *' }),
    null,
  );
  assert.equal(
    readToolAuthorizationMatcher({ type: 'url_domain', value: { origin: 'https://example.test' } }),
    null,
  );
  assert.equal(readToolAuthorizationMatcher({ type: 'exact', key: 'invalid' }), null);
});

test('authorization matching compares tool name and candidate matcher only', () => {
  const matcher = exactAuthorization({ argv: ['npm', 'test'], cwd: '/repo' });
  const authorizations = [authorizeToolAction({
    toolName: 'run_process',
    matcher,
    source: 'human',
  })];

  assert.equal(
    isToolActionAuthorized({
      authorizations,
      toolName: 'run_process',
      candidateMatcher: exactAuthorization({ cwd: '/repo', argv: ['npm', 'test'] }),
    }),
    true,
  );
  assert.equal(
    isToolActionAuthorized({
      authorizations,
      toolName: 'run_process',
      candidateMatcher: exactAuthorization({ argv: ['npm', 'build'], cwd: '/repo' }),
    }),
    false,
  );
  assert.equal(
    isToolActionAuthorized({
      authorizations,
      toolName: 'other_process_tool',
      candidateMatcher: matcher,
    }),
    false,
  );
});

test('URL origin grants compare normalized origins', () => {
  const matcher = urlOriginAuthorization('https://Example.test/a');
  assert.ok(matcher);
  const authorizations = [authorizeToolAction({
    toolName: 'browser_open',
    matcher,
    source: 'human',
  })];

  assert.equal(
    isToolActionAuthorized({
      authorizations,
      toolName: 'browser_open',
      candidateMatcher: urlOriginAuthorization('https://example.test/b')!,
    }),
    true,
  );
  assert.equal(
    isToolActionAuthorized({
      authorizations,
      toolName: 'browser_open',
      candidateMatcher: urlOriginAuthorization('http://example.test/a')!,
    }),
    false,
  );
});

test('applyReviewEffects rejects authorization without a prepared matcher', async () => {
  await assert.rejects(
    () => applyReviewEffects({
      toolName: 'run_process',
      matcher: null,
      effects: [{
        type: 'graph.authorize_tool_action',
        scope: 'thread',
      }],
    }),
    (error) => error instanceof ReviewEffectApplicationError
      && error.code === 'missing_policy_matcher',
  );
});

test('authorizeToolAction validates matcher shape before storing state', () => {
  assert.throws(
    () => authorizeToolAction({
      toolName: 'run_process',
      matcher: { type: 'exact', key: 'invalid' },
      source: 'human',
    }),
    (error) => error instanceof ReviewEffectApplicationError
      && error.code === 'invalid_matcher',
  );
});

test('mergeToolAuthorizations dedupes records and upgrades auto grants to human', () => {
  const firstMatcher = exactAuthorization({ argv: ['npm', 'test'], cwd: '/repo' });
  const secondMatcher = exactAuthorization({ argv: ['npm', 'run', 'build'], cwd: '/repo' });
  const merged = mergeToolAuthorizations(
    [{
      toolName: 'run_process',
      matcher: firstMatcher,
      createdAt: '2026-07-29T00:00:00.000Z',
      source: 'auto_review',
    }],
    [
      {
        toolName: 'run_process',
        matcher: firstMatcher,
        createdAt: '2026-07-29T00:01:00.000Z',
        source: 'human',
      },
      {
        toolName: 'run_process',
        matcher: secondMatcher,
        createdAt: '2026-07-29T00:02:00.000Z',
        source: 'auto_review',
      },
    ],
  );

  assert.deepEqual(merged, [
    {
      toolName: 'run_process',
      matcher: firstMatcher,
      createdAt: '2026-07-29T00:01:00.000Z',
      source: 'human',
    },
    {
      toolName: 'run_process',
      matcher: secondMatcher,
      createdAt: '2026-07-29T00:02:00.000Z',
      source: 'auto_review',
    },
  ]);
});

test('mergeToolAuthorizations ignores legacy records', () => {
  const legacy = {
    toolName: 'run_shell',
    matcher: { type: 'exact_args', value: { command: 'npm test' } },
    createdAt: '2026-07-29T00:00:00.000Z',
  } as never;

  assert.deepEqual(mergeToolAuthorizations([legacy], []), []);
  assert.deepEqual(mergeToolAuthorizations([{
    toolName: 'run_shell',
    matcher: exactAuthorization({ command: 'npm test' }),
    source: 'human',
  } as never], []), []);
});
