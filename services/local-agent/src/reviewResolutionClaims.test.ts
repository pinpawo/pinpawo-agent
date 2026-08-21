import assert from 'node:assert/strict';
import test from 'node:test';
import { ReviewResolutionClaims } from './reviewResolutionClaims';

type Route = { actionId: string; requestId: string };

const route: Route = { actionId: 'action-1', requestId: 'req-1' };

test('a claimed action cannot be claimed again until it is released', async () => {
  const claims = new ReviewResolutionClaims<Route>();
  claims.register(route);

  assert.deepEqual(await claims.claim(route, async () => null), {
    actionId: 'action-1',
    route,
  });

  // Guards a double submit from one client: a repeat click, a resent message.
  assert.equal(await claims.claim(route, async () => null), null);

  claims.release('action-1', { resolved: false });
  assert.ok(await claims.claim(route, async () => null));
});

test('a resolved action drops its cached route', () => {
  const claims = new ReviewResolutionClaims<Route>();
  claims.register(route);

  claims.release('action-1', { resolved: true });

  // Nothing is remembered about the resolved review: once its resume is
  // applied the checkpoint stops reporting it, so memory has nothing to add.
  assert.deepEqual(claims.routes(), []);
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

  // The recovered route is cached, so the next attempt needs no second read.
  claims.release('action-1', { resolved: false });
  await claims.claim({ requestId: 'req-1' }, async () => {
    recovered += 1;
    return route;
  });
  assert.equal(recovered, 1);
});

test('claiming reports nothing when the checkpoint has no pending review', async () => {
  const claims = new ReviewResolutionClaims<Route>();

  assert.equal(await claims.claim({ requestId: 'missing' }, async () => null), null);
});

test('a recovered route for a different action does not satisfy the request', async () => {
  const claims = new ReviewResolutionClaims<Route>();

  // The checkpoint moved on to a different review than the one being answered.
  const resolution = await claims.claim(
    { requestId: 'req-1', actionId: 'action-1' },
    async () => ({ actionId: 'action-2', requestId: 'req-1' }),
  );

  assert.equal(resolution, null);
});

test('a review raised after one resolves is registered in its own right', async () => {
  const claims = new ReviewResolutionClaims<Route>();
  claims.register(route);
  await claims.claim(route, async () => null);
  claims.release('action-1', { resolved: true });

  // Nothing about the resolved action lingers, so a later review — including
  // a re-ask under the same interrupt id, which the middleware raises when a
  // decision could not be understood — is answerable once registered.
  claims.register(route);
  assert.ok(await claims.claim(route, async () => null));
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
