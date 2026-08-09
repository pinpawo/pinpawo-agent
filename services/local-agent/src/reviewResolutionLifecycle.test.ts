import assert from 'node:assert/strict';
import test from 'node:test';
import { ReviewResolutionLifecycle } from './reviewResolutionLifecycle';

type Route = {
  actionId: string;
  requestId: string;
};

test('review resolution releases a queued interrupt only after checkpointing', async () => {
  const lifecycle = new ReviewResolutionLifecycle<Route>();
  const route = { actionId: 'action-1', requestId: 'req-1' };
  lifecycle.register(route);

  assert.deepEqual(
    await lifecycle.begin(route, async () => null),
    { actionId: 'action-1', route },
  );
  assert.equal(await lifecycle.begin(route, async () => null), null);
  assert.equal(lifecycle.queueInterrupt('req-1'), true);
  assert.equal(lifecycle.checkpoint('req-1'), true);
  assert.equal(lifecycle.checkpoint('req-1'), false);
});

test('run interrupt is routed from the authoritative review lifecycle state', async () => {
  const lifecycle = new ReviewResolutionLifecycle<Route>();
  const route = { actionId: 'action-1', requestId: 'req-1' };
  lifecycle.register(route);

  assert.deepEqual(lifecycle.routeRunInterrupt('req-1'), {
    type: 'cancel_pending',
    route,
  });
  const resolution = await lifecycle.begin(route, async () => null);
  assert.ok(resolution);
  assert.deepEqual(lifecycle.routeRunInterrupt('req-1'), { type: 'queued' });
  assert.equal(lifecycle.checkpoint('req-1'), true);
  lifecycle.abandon(resolution.actionId);
  assert.deepEqual(lifecycle.routeRunInterrupt('req-1'), {
    type: 'cancel_pending',
    route,
  });
  assert.deepEqual(lifecycle.routeRunInterrupt('req-unknown'), { type: 'unhandled' });
});

test('consumed review actions stay unavailable across request envelopes', async () => {
  const lifecycle = new ReviewResolutionLifecycle<Route>();
  const route = { actionId: 'action-1', requestId: 'req-1' };
  lifecycle.register(route);
  const resolution = await lifecycle.begin(route, async () => null);
  assert.ok(resolution);
  lifecycle.settle(resolution.actionId, true);

  assert.equal(await lifecycle.begin({
    actionId: 'action-1',
    requestId: 'req-2',
  }, async () => ({ ...route, requestId: 'req-2' })), null);
});

test('abandoned review resolution returns its route to available state', async () => {
  const lifecycle = new ReviewResolutionLifecycle<Route>();
  const route = { actionId: 'action-1', requestId: 'req-1' };
  lifecycle.register(route);
  const resolution = await lifecycle.begin(route, async () => null);
  assert.ok(resolution);
  assert.equal(lifecycle.queueInterrupt('req-1'), true);
  lifecycle.abandon(resolution.actionId);

  assert.equal(lifecycle.checkpoint('req-1'), false);
  assert.deepEqual(
    await lifecycle.begin(route, async () => null),
    { actionId: 'action-1', route },
  );
});

test('an observed pending review reopens a consumed action', async () => {
  const lifecycle = new ReviewResolutionLifecycle<Route>();
  const route = { actionId: 'action-1', requestId: 'req-1' };
  lifecycle.register(route);
  const first = await lifecycle.begin(route, async () => null);
  assert.ok(first);
  lifecycle.settle(first.actionId, true);

  const reopened = { ...route, requestId: 'req-2' };
  lifecycle.register(reopened, { observedPending: true });
  assert.deepEqual(
    await lifecycle.begin(reopened, async () => null),
    { actionId: 'action-1', route: reopened },
  );
});

test('a pending review observed during resolution remains available after settling', async () => {
  const lifecycle = new ReviewResolutionLifecycle<Route>();
  const route = { actionId: 'action-1', requestId: 'req-1' };
  lifecycle.register(route);
  const resolution = await lifecycle.begin(route, async () => null);
  assert.ok(resolution);

  const pendingAgain = { ...route, requestId: 'req-2' };
  lifecycle.register(pendingAgain, { observedPending: true });
  lifecycle.settle(resolution.actionId, true);

  assert.deepEqual(
    await lifecycle.begin(pendingAgain, async () => null),
    { actionId: 'action-1', route: pendingAgain },
  );
});
