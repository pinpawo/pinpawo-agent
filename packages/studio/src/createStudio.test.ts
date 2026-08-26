import assert from 'node:assert/strict';
import test from 'node:test';
import type { PetDispatchPort, PetDispatchResult } from 'pinpawo/host-runtime';

import { createStudio } from './createStudio';
import type { StudioPlugin } from './studioContract';
import type { StudioPetBinding } from './types';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function binding(
  petId: string,
  run: (request: string, signal?: AbortSignal) => Promise<PetDispatchResult>
    = async (request) => ({ status: 'completed', output: request }),
): StudioPetBinding {
  const port: PetDispatchPort = {
    getState: () => 'open',
    onStateChange: () => () => undefined,
    dispatch: ({ request, signal }) => run(request, signal),
  };
  return {
    registration: {
      petId,
      name: petId.toUpperCase(),
      role: `${petId} role`,
      serviceSummary: `${petId} service`,
    },
    dispatch: port,
  };
}

test('Studio dispatches request-only input and returns no thread or continuation data', async () => {
  const seen: unknown[] = [];
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [binding('worker', async (request) => {
      seen.push(request);
      return { status: 'waiting' };
    })],
  });

  const receipt = await studio.dispatch({ petId: 'worker', request: 'draft' });
  const result = await receipt.completion;
  assert.deepEqual(seen, ['draft']);
  assert.deepEqual(Object.keys(receipt).sort(), ['completion', 'invocationId', 'onInvocation', 'petId']);
  assert.equal(result.status, 'waiting');
  assert.equal('threadId' in result, false);
  assert.equal('pendingContinuation' in result, false);
  await studio.shutdown();
});

test('Studio serializes dispatches per Pet while allowing different Pets independently', async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const events: string[] = [];
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'a',
    pets: [
      binding('a', async (request) => {
        events.push(`${request}:start`);
        if (request === 'a1') {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        events.push(`${request}:end`);
        return { status: 'completed', output: request };
      }),
      binding('b', async (request) => {
        events.push(`${request}:run`);
        return { status: 'completed', output: request };
      }),
    ],
  });

  const a1 = await studio.dispatch({ petId: 'a', request: 'a1' });
  await firstStarted.promise;
  const a2 = await studio.dispatch({ petId: 'a', request: 'a2' });
  const b1 = await studio.dispatch({ petId: 'b', request: 'b1' });
  await b1.completion;
  assert.deepEqual(events, ['a1:start', 'b1:run']);
  releaseFirst.resolve();
  await Promise.all([a1.completion, a2.completion]);
  assert.deepEqual(events, ['a1:start', 'b1:run', 'a1:end', 'a2:start', 'a2:end']);
  await studio.shutdown();
});

test('receipt observer replays latest invocation state and metadata stays above the port', async () => {
  const release = deferred();
  let portRequest: string | undefined;
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [binding('worker', async (request) => {
      portRequest = request;
      await release.promise;
      return { status: 'completed', output: 'done' };
    })],
  });
  const receipt = await studio.dispatch({
    petId: 'worker',
    request: 'work',
    metadata: { taskId: 'task-1' },
  });
  await Promise.resolve();
  const statuses: string[] = [];
  receipt.onInvocation((event) => {
    statuses.push(event.status);
  });
  assert.deepEqual(statuses, ['busy']);
  assert.equal(portRequest, 'work');
  release.resolve();
  assert.equal((await receipt.completion).output, 'done');
  assert.deepEqual(statuses, ['busy', 'completed']);
  await studio.shutdown();
});

test('idempotency returns the same receipt and invokes the port once', async () => {
  let calls = 0;
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [binding('worker', async () => {
      calls += 1;
      return { status: 'completed', output: 'done' };
    })],
  });
  const request = { petId: 'worker', request: 'work', idempotencyKey: 'task-1' };
  const first = await studio.dispatch(request);
  const second = await studio.dispatch(request);
  assert.equal(first, second);
  await first.completion;
  assert.equal(calls, 1);
  await studio.shutdown();
});

test('listPets exposes only Studio registration metadata', async () => {
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [binding('worker')],
  });
  assert.deepEqual(studio.listPets(), [{
    petId: 'worker',
    name: 'WORKER',
    role: 'worker role',
    serviceSummary: 'worker service',
  }]);
  await studio.shutdown();
});

test('Plugin receives dispatch/event/hook context without a Pet runtime reference', async () => {
  let pluginContextKeys: string[] = [];
  let eventSource = '';
  const plugin: StudioPlugin = {
    name: 'scheduler',
    toolkits: [],
    start: async (context) => {
      pluginContextKeys = Object.keys(context).sort();
      context.subscribe((event) => {
        eventSource = event.source;
      });
      context.notify({ type: 'schedule.ready' });
      await (await context.dispatch({ petId: 'worker', request: 'run' })).completion;
    },
  };
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [binding('worker')],
    plugins: [plugin],
  });
  assert.deepEqual(pluginContextKeys, [
    'dispatch',
    'hooks',
    'listPets',
    'notify',
    'onInvocation',
    'subscribe',
  ]);
  assert.equal(eventSource, 'scheduler');
  await studio.shutdown();
});

test('Plugin startup failure rolls back already-started Plugins', async () => {
  const events: string[] = [];
  const first: StudioPlugin = {
    name: 'first',
    toolkits: [],
    start: () => {
      events.push('first:start');
    },
    stop: () => {
      events.push('first:stop');
    },
  };
  const second: StudioPlugin = {
    name: 'second',
    toolkits: [],
    start: () => {
      events.push('second:start');
      throw new Error('boom');
    },
    stop: () => {
      events.push('second:stop');
    },
  };
  await assert.rejects(() => createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [binding('worker')],
    plugins: [first, second],
  }), /boom/);
  assert.deepEqual(events, ['first:start', 'second:start', 'second:stop', 'first:stop']);
});

test('shutdown cancels the signal of an active dispatch', async () => {
  const started = deferred();
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [binding('worker', async (_request, signal) => {
      started.resolve();
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { status: 'cancelled' };
    })],
  });
  const receipt = await studio.dispatch({ petId: 'worker', request: 'long' });
  await started.promise;
  await studio.shutdown();
  assert.equal((await receipt.completion).status, 'cancelled');
});
