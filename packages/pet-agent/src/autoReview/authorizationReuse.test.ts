import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthorizationPolicies } from './reviewPolicies';
import { canReuseAutoReviewAuthorization } from './authorizationReuse';
import { exactAuthorization, urlOriginAuthorization, toolAuthorizationMatchersEqual } from './authorizationMatchers';

test('automatic reuse requires exact scope and policy consent, not just an exact digest', () => {
  const matcher = exactAuthorization({ path: '/repo/a' });
  assert.equal(canReuseAutoReviewAuthorization(AuthorizationPolicies.exact(), matcher), true);
  assert.equal(canReuseAutoReviewAuthorization(AuthorizationPolicies.exact({ subject: ({ input }) => input }), matcher), false);
  assert.equal(canReuseAutoReviewAuthorization(AuthorizationPolicies.exact({ subject: ({ input }) => input, reuseAutoReview: true }), matcher), true);
  assert.equal(canReuseAutoReviewAuthorization(AuthorizationPolicies.exact({ reuseAutoReview: false }), matcher), false);
  assert.equal(canReuseAutoReviewAuthorization({ buildMatcher: () => matcher }, matcher), false);
  assert.equal(canReuseAutoReviewAuthorization({ buildMatcher: () => null, reuseAutoReview: true }, urlOriginAuthorization('https://example.com/a')), false);
  assert.equal(canReuseAutoReviewAuthorization(undefined, matcher), false);
});

test('exact matches projected identity; origin matches scheme host and effective port', async () => {
  const policy = AuthorizationPolicies.exact({ subject: ({ input }) => (input as { identity: unknown }).identity });
  const context = { toolkitName: 'test', toolName: 'test' };
  const a = await policy.buildMatcher!({ ...context, input: { identity: { a: 1, b: 2 }, timeout: 1 } });
  const b = await policy.buildMatcher!({ ...context, input: { identity: { b: 2, a: 1 }, timeout: 20 } });
  assert.deepEqual(a, b);
  const origin = urlOriginAuthorization('https://example.com:443/a?q=1')!;
  assert.equal(toolAuthorizationMatchersEqual(origin, urlOriginAuthorization('https://example.com/b')!), true);
  for (const url of ['http://example.com/a', 'https://sub.example.com/a', 'https://example.com:444/a']) {
    assert.equal(toolAuthorizationMatchersEqual(origin, urlOriginAuthorization(url)!), false);
  }
});

test('historical environment-scoped grants cannot become unscoped grants', async () => {
  const { readToolAuthorizationMatcher } = await import('./authorizationMatchers');
  const exact = exactAuthorization({ cwd: '/workspace', command: 'pwd' });
  const origin = urlOriginAuthorization('https://example.com')!;
  for (const matcher of [exact, origin]) {
    assert.equal(readToolAuthorizationMatcher({ ...matcher, scope: 'old-environment' }), null);
    assert.deepEqual(readToolAuthorizationMatcher(matcher), matcher);
  }
});
