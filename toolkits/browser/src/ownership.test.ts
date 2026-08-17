import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserOperationError } from './errors';
import type { BrowserExecutionOwner } from './ownership';
import { BrowserContextOwnership } from './ownership';

function owner(threadId = 'thread-1'): BrowserExecutionOwner {
  return { threadId };
}

test('same thread can reuse browser ownership across executions', async () => {
  const ownership = new BrowserContextOwnership();

  assert.equal(await ownership.runOpen(owner(), async () => 'opened'), 'opened');
  assert.equal(await ownership.runOwned(owner(), async () => 'snapshot'), 'snapshot');
});

test('another thread must explicitly open before using the browser', async () => {
  const ownership = new BrowserContextOwnership();
  const first = owner('thread-1');
  const second = owner('thread-2');
  let operationCalled = false;

  await ownership.runOpen(first, async () => 'opened');
  await assert.rejects(
    ownership.runOwned(second, async () => {
      operationCalled = true;
      return 'snapshot';
    }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'browser_context_conflict',
  );
  assert.equal(operationCalled, false);

  assert.equal(await ownership.runOpen(second, async () => 'reopened'), 'reopened');
  await assert.rejects(
    ownership.runOwned(first, async () => 'stale operation'),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'browser_context_conflict',
  );
});

test('thread handoff waits for an in-flight operation', async () => {
  const ownership = new BrowserContextOwnership();
  const first = owner('thread-1');
  const second = owner('thread-2');
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
  const thread = owner();
  let releaseOperation: (() => void) | undefined;
  let cancelledOperationStarted = false;

  await ownership.runOpen(thread, async () => 'opened');
  const inFlight = ownership.runOwned(thread, async () => {
    await new Promise<void>((resolve) => { releaseOperation = resolve; });
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  const cancelled = ownership.runOwned(thread, async () => {
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
  const first = owner('thread-1');
  const second = owner('thread-2');

  await ownership.runOpen(first, async () => 'opened');
  await assert.rejects(
    ownership.runOpen(second, async () => {
      throw new Error('navigation failed');
    }),
    /navigation failed/,
  );
  await assert.rejects(
    ownership.runOwned(second, async () => 'snapshot'),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'browser_not_open',
  );
});

test('navigation timeout retains ownership so a later execution in the same thread can wait', async () => {
  const ownership = new BrowserContextOwnership();

  await assert.rejects(
    ownership.runOpen(owner(), async () => {
      throw new BrowserOperationError(
        'navigation_timeout',
        'Page did not become readable. Use browser_wait to continue.',
        true,
      );
    }),
    (error: unknown) => error instanceof BrowserOperationError
      && error.code === 'navigation_timeout',
  );

  assert.equal(
    await ownership.runOwned(owner(), async () => 'wait resumed'),
    'wait resumed',
  );
});

test('bridge navigation timeout also retains the thread ownership', async () => {
  const ownership = new BrowserContextOwnership();

  await assert.rejects(
    ownership.runOpen(owner(), async () => {
      throw Object.assign(new Error('extension still loading'), {
        code: 'navigation_timeout',
      });
    }),
    /extension still loading/,
  );

  assert.equal(
    await ownership.runOwned(owner(), async () => 'wait resumed'),
    'wait resumed',
  );
});

test('navigation timeout transfers ownership to a new explicit opener thread', async () => {
  const ownership = new BrowserContextOwnership();
  const first = owner('thread-1');
  const second = owner('thread-2');

  await ownership.runOpen(first, async () => 'opened');
  await assert.rejects(
    ownership.runOpen(second, async () => {
      throw new BrowserOperationError('navigation_timeout', 'still loading', true);
    }),
    (error: unknown) => error instanceof BrowserOperationError
      && error.code === 'navigation_timeout',
  );

  assert.equal(await ownership.runOwned(second, async () => 'wait resumed'), 'wait resumed');
  await assert.rejects(
    ownership.runOwned(first, async () => 'stale operation'),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'browser_context_conflict',
  );
});

test('only the current thread can close the browser', async () => {
  const ownership = new BrowserContextOwnership();
  const first = owner('thread-1');
  const second = owner('thread-2');
  let closeCalled = false;

  await ownership.runOpen(first, async () => 'opened');
  await assert.rejects(
    ownership.closeOwned(second, async () => {
      closeCalled = true;
      return 'closed';
    }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'browser_context_conflict',
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
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'browser_not_open',
  );
});
