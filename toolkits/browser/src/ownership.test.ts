import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserExecutionOwner } from './ownership';
import { BrowserContextOwnership } from './ownership';

function owner(
  delegationId: string,
  runId = `run-${delegationId}`,
): BrowserExecutionOwner {
  return {
    threadId: 'thread-1',
    runId,
    delegationId,
  };
}

test('same delegation can reuse its browser ownership', async () => {
  const ownership = new BrowserContextOwnership();
  const delegation = owner('delegation-1');

  assert.equal(await ownership.runOpen(delegation, async () => 'opened'), 'opened');
  assert.equal(await ownership.runOwned({ ...delegation }, async () => 'snapshot'), 'snapshot');
});

test('release drops active ownership and only the same execution can resume it', async () => {
  const ownership = new BrowserContextOwnership();
  const first = owner('delegation-1');
  const second = owner('delegation-2');

  await ownership.runOpen(first, async () => 'opened');
  await ownership.release(first);
  await assert.rejects(
    ownership.runOwned(first, async () => 'snapshot'),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'browser_not_open',
  );

  await ownership.acquire(second);
  await assert.rejects(
    ownership.runOwned(second, async () => 'foreign snapshot'),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'browser_not_open',
  );

  await ownership.acquire({ ...first });
  assert.equal(await ownership.runOwned(first, async () => 'resumed'), 'resumed');
});

test('another delegation must explicitly open before using the browser', async () => {
  const ownership = new BrowserContextOwnership();
  const first = owner('delegation-1');
  const second = owner('delegation-2');
  let operationCalled = false;

  await ownership.runOpen(first, async () => 'opened');
  await assert.rejects(
    ownership.runOwned(second, async () => {
      operationCalled = true;
      return 'snapshot';
    }),
    (error: unknown) => (
      error instanceof Error
      && 'code' in error
      && error.code === 'browser_context_conflict'
    ),
  );
  assert.equal(operationCalled, false);

  assert.equal(await ownership.runOpen(second, async () => 'reopened'), 'reopened');
  await assert.rejects(
    ownership.runOwned(first, async () => 'stale operation'),
    (error: unknown) => (
      error instanceof Error
      && 'code' in error
      && error.code === 'browser_context_conflict'
    ),
  );
});

test('ownership transfer waits for an in-flight operation', async () => {
  const ownership = new BrowserContextOwnership();
  const first = owner('delegation-1');
  const second = owner('delegation-2');
  const events: string[] = [];
  let releaseOperation: (() => void) | undefined;

  await ownership.runOpen(first, async () => 'opened');
  const firstOperation = ownership.runOwned(first, async () => {
    events.push('first:start');
    await new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    events.push('first:end');
  });
  const transfer = ownership.runOpen(second, async () => {
    events.push('second:open');
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first:start']);
  releaseOperation?.();
  await Promise.all([firstOperation, transfer]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:open']);
});

test('an aborted queued operation never reaches the browser driver', async () => {
  const ownership = new BrowserContextOwnership();
  const delegation = owner('delegation-1');
  let releaseOperation: (() => void) | undefined;
  let cancelledOperationStarted = false;

  await ownership.runOpen(delegation, async () => 'opened');
  const inFlight = ownership.runOwned(delegation, async () => {
    await new Promise<void>((resolve) => { releaseOperation = resolve; });
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  const cancelled = ownership.runOwned(delegation, async () => {
    cancelledOperationStarted = true;
  }, controller.signal);
  controller.abort();
  assert.ok(releaseOperation);
  releaseOperation();

  await inFlight;
  await assert.rejects(
    cancelled,
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'browser_command_cancelled',
  );
  assert.equal(cancelledOperationStarted, false);
});

test('failed open clears ownership instead of exposing the previous context', async () => {
  const ownership = new BrowserContextOwnership();
  const first = owner('delegation-1');
  const second = owner('delegation-2');

  await ownership.runOpen(first, async () => 'opened');
  await assert.rejects(
    ownership.runOpen(second, async () => {
      throw new Error('navigation failed');
    }),
    /navigation failed/,
  );
  await assert.rejects(
    ownership.runOwned(second, async () => 'snapshot'),
    (error: unknown) => (
      error instanceof Error
      && 'code' in error
      && error.code === 'browser_not_open'
    ),
  );
});

test('only the current delegation can close the browser', async () => {
  const ownership = new BrowserContextOwnership();
  const first = owner('delegation-1');
  const second = owner('delegation-2');
  let closeCalled = false;

  await ownership.runOpen(first, async () => 'opened');
  await assert.rejects(
    ownership.closeOwned(second, async () => {
      closeCalled = true;
      return 'closed';
    }),
    (error: unknown) => (
      error instanceof Error
      && 'code' in error
      && error.code === 'browser_context_conflict'
    ),
  );
  assert.equal(closeCalled, false);
  assert.equal(await ownership.runOwned(first, async () => 'snapshot'), 'snapshot');

  assert.equal(
    await ownership.closeOwned(first, async () => {
      closeCalled = true;
      return 'closed';
    }),
    'closed',
  );
  assert.equal(closeCalled, true);
  await assert.rejects(
    ownership.runOwned(first, async () => 'snapshot'),
    (error: unknown) => (
      error instanceof Error
      && 'code' in error
      && error.code === 'browser_not_open'
    ),
  );
});
