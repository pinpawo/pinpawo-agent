import assert from 'node:assert/strict';
import test from 'node:test';
import { ReviewResolutionClaims } from './reviewResolutionClaims';

type Route = { actionId: string; requestId: string };

const route: Route = { actionId: 'action-1', requestId: 'req-1' };

test('a claimed action cannot be claimed again until it is released', async () => {
  const claims = new ReviewResolutionClaims<Route>();
  claims.register(route);

  const first = await claims.claim(route, async () => null);
  assert.deepEqual(first, { actionId: 'action-1', route });

  // Guards a double submit from one client (repeat click, resent message).
  assert.equal(await claims.claim(route, async () => null), null);

  claims.release('action-1', { resolved: false });
  assert.ok(await claims.claim(route, async () => null));
});

test('a resolved action drops its route and stays resolved', async () => {
  const claims = new ReviewResolutionClaims<Route>();
  claims.register(route);

  claims.release('action-1', { resolved: true });

  assert.deepEqual(claims.routes(), []);
  // A checkpoint read can still surface a just-resolved action for a moment;
  // re-registering it must not re-offer a decision that was already applied.
  assert.equal(claims.register(route), false);
  assert.deepEqual(claims.routes(), []);
  assert.equal(await claims.claim(route, async () => route), null);
});

test('a review raised again mid-resolution survives the settle', async () => {
  const claims = new ReviewResolutionClaims<Route>();
  claims.register(route);
  await claims.claim(route, async () => null);

  // A batch raises its next review from the same interrupt, so the follow-up
  // reuses the action id and arrives before the first one settles.
  claims.register(route, { observedPending: true });
  claims.release('action-1', { resolved: true });

  assert.deepEqual(claims.routes(), [route]);
  assert.ok(
    await claims.claim(route, async () => null),
    'the follow-up review must stay answerable',
  );
});

// LangGraph reuses one interrupt id for successive interrupt() calls in the
// same node — verified against a real graph — so the action id alone cannot
// tell a resolved review apart from the follow-up that replaces it.
test('a new review under a reused interrupt id is not mistaken for a stale echo', async () => {
  type Reviewed = Route & { reviews: { id: string }[] };
  const claims = new ReviewResolutionClaims<Reviewed>();
  const first: Reviewed = { actionId: 'i-1', requestId: 'i-1', reviews: [{ id: 'rev-a' }] };
  const second: Reviewed = { actionId: 'i-1', requestId: 'i-1', reviews: [{ id: 'rev-b' }] };

  claims.register(first);
  await claims.claim(first, async () => null);
  claims.release('i-1', { resolved: true });

  // The same review read back from a checkpoint is a stale echo.
  assert.equal(claims.register(first), false);
  // A different review under the same id is genuinely new, even when it is
  // only ever seen through a checkpoint read.
  assert.equal(claims.register(second), true);
  assert.ok(
    await claims.claim(second, async () => null),
    'the follow-up review must be answerable',
  );
});

test('a recovered route cannot revive a resolved action', async () => {
  const claims = new ReviewResolutionClaims<Route>();
  claims.register(route);
  claims.release('action-1', { resolved: true });

  // Recovery reads the checkpoint, which may still show the resumed review.
  assert.equal(await claims.claim({ requestId: 'req-1' }, async () => route), null);
});

test('a failed resolution keeps its route for the next attempt', () => {
  const claims = new ReviewResolutionClaims<Route>();
  claims.register(route);

  claims.release('action-1', { resolved: false });

  assert.deepEqual(claims.routes(), [route]);
});

test('an unknown action recovers its route from the checkpoint', async () => {
  const claims = new ReviewResolutionClaims<Route>();
  let recovered = 0;

  const resolution = await claims.claim({ requestId: 'req-1' }, async () => {
    recovered += 1;
    return route;
  });

  assert.deepEqual(resolution, { actionId: 'action-1', route });
  assert.equal(recovered, 1);
  // The recovered route is cached, so resolving it again needs no second read.
  claims.release('action-1', { resolved: false });
  await claims.claim({ requestId: 'req-1' }, async () => {
    recovered += 1;
    return route;
  });
  assert.equal(recovered, 1);
});

test('claiming reports nothing when no route can be recovered', async () => {
  const claims = new ReviewResolutionClaims<Route>();

  assert.equal(await claims.claim({ requestId: 'missing' }, async () => null), null);
});

test('re-registering a claimed action refreshes its route', async () => {
  const claims = new ReviewResolutionClaims<Route>();
  claims.register(route);
  await claims.claim(route, async () => null);

  // The checkpoint decides whether the review still exists, so a newer
  // observation of the same action is never stale.
  const refreshed = { ...route, requestId: 'req-2' };
  claims.register(refreshed);

  assert.deepEqual(claims.routes(), [refreshed]);
});

test('a run interrupt is queued while the action is being resolved', async () => {
  const claims = new ReviewResolutionClaims<Route>();
  claims.register(route);
  await claims.claim(route, async () => null);

  assert.deepEqual(claims.routeRunInterrupt('req-1'), { type: 'queued' });
  // Delivered once the resume reaches a checkpoint, and only once.
  assert.equal(claims.checkpoint('req-1'), true);
  assert.equal(claims.checkpoint('req-1'), false);
});

test('a run interrupt cancels a pending review that is not being resolved', () => {
  const claims = new ReviewResolutionClaims<Route>();
  claims.register(route);

  assert.deepEqual(claims.routeRunInterrupt('req-1'), {
    type: 'cancel_pending',
    route,
  });
  assert.deepEqual(claims.routeRunInterrupt('other'), { type: 'unhandled' });
});

test('checkpoint reports no queued interrupt when none was requested', async () => {
  const claims = new ReviewResolutionClaims<Route>();
  claims.register(route);
  await claims.claim(route, async () => null);

  assert.equal(claims.checkpoint('req-1'), false);
});

test('removeRoutes drops matching routes and their claims', async () => {
  const claims = new ReviewResolutionClaims<Route & { userId?: string }>();
  const mine = { actionId: 'a', requestId: 'r1', userId: 'u1' };
  const other = { actionId: 'b', requestId: 'r2', userId: 'u2' };
  claims.register(mine);
  claims.register(other);
  await claims.claim(mine, async () => null);

  claims.removeRoutes((candidate) => candidate.userId === 'u1');

  assert.deepEqual(claims.routes(), [other]);
  // The claim went with it, so the action is free again.
  assert.ok(await claims.claim(mine, async () => mine));
});
