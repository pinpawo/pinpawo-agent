import assert from 'node:assert/strict';
import test from 'node:test';
import type { PetDispatchPort } from 'pinpawo/host-runtime';

import { createStudio, prepareStudio } from './createStudio';
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
  run: (request: string) => void | Promise<void> = () => undefined,
): StudioPetBinding {
  const port: PetDispatchPort = {
    getState: () => 'open',
    onStateChange: () => () => undefined,
    dispatch: async ({ request }) => { await run(request); },
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
    pets: [binding('worker', (request) => {
      seen.push(request);
    })],
  });

  const receipt = await studio.dispatch({ petId: 'worker', request: 'draft' });
  assert.deepEqual(seen, ['draft']);
  assert.deepEqual(Object.keys(receipt).sort(), ['invocationId', 'petId']);
  assert.equal('completion' in receipt, false);
  assert.equal('status' in receipt, false);
  await studio.shutdown();
});

test('Studio delegates queue ownership to each live Pet dispatch port', async () => {
  const events: string[] = [];
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'a',
    pets: [
      binding('a', (request) => {
        events.push(request);
      }),
      binding('b', (request) => {
        events.push(request);
      }),
    ],
  });

  await studio.dispatch({ petId: 'a', request: 'a1' });
  await studio.dispatch({ petId: 'a', request: 'a2' });
  await studio.dispatch({ petId: 'b', request: 'b1' });
  assert.deepEqual(events, ['a1', 'a2', 'b1']);
  await studio.shutdown();
});

test('receipt echoes producer metadata while the Pet sees request text only', async () => {
  let portRequest: string | undefined;
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [binding('worker', (request) => {
      portRequest = request;
    })],
  });
  const receipt = await studio.dispatch({
    petId: 'worker',
    request: 'work',
    metadata: { taskId: 'task-1' },
  });
  assert.equal(portRequest, 'work');
  assert.deepEqual(receipt.metadata, { taskId: 'task-1' });
  await studio.shutdown();
});

test('idempotency returns the same receipt and invokes the port once', async () => {
  let calls = 0;
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [binding('worker', () => {
      calls += 1;
    })],
  });
  const request = { petId: 'worker', request: 'work', idempotencyKey: 'task-1' };
  const first = await studio.dispatch(request);
  const second = await studio.dispatch(request);
  assert.equal(first, second);
  assert.equal(calls, 1);
  await studio.shutdown();
});

test('dispatch rejects when the Pet cannot accept the input', async () => {
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [binding('worker', () => {
      throw new Error('resident is closing');
    })],
  });
  await assert.rejects(
    () => studio.dispatch({ petId: 'worker', request: 'work' }),
    /resident is closing/,
  );
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
      await context.dispatch({ petId: 'worker', request: 'run' });
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
    'subscribe',
  ]);
  assert.equal(eventSource, 'scheduler');
  await studio.shutdown();
});

test('prepared Studio does not start Plugins until the Host activates them', async () => {
  const events: string[] = [];
  const prepared = prepareStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [binding('worker')],
    plugins: [{
      name: 'http',
      toolkits: [],
      start: () => { events.push('http:start'); },
      stop: () => { events.push('http:stop'); },
    }],
  });

  assert.deepEqual(events, []);
  await prepared.activatePlugins();
  await prepared.activatePlugins();
  assert.deepEqual(events, ['http:start']);
  await prepared.studio.shutdown();
  assert.deepEqual(events, ['http:start', 'http:stop']);
});

test('Studio core event bus preserves per-subscriber order without cross-subscriber blocking', async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const slowDeliveryComplete = deferred();
  const fastDeliveryComplete = deferred();
  const slowEvents: string[] = [];
  const fastEvents: string[] = [];
  const slowSubscriber: StudioPlugin = {
    name: 'slow-subscriber',
    toolkits: [],
    start: (context) => {
      context.subscribe(async (event) => {
        slowEvents.push(`${event.source}:${event.type}`);
        if (event.type === 'event.first') {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        if (event.type === 'event.second') slowDeliveryComplete.resolve();
      });
    },
  };
  const fastSubscriber: StudioPlugin = {
    name: 'fast-subscriber',
    toolkits: [],
    start: (context) => {
      context.subscribe((event) => {
        fastEvents.push(`${event.source}:${event.type}`);
        if (event.type === 'event.second') fastDeliveryComplete.resolve();
      });
    },
  };
  const publisher: StudioPlugin = {
    name: 'publisher',
    toolkits: [],
    start: (context) => {
      context.notify({ type: 'event.first' });
      context.notify({ type: 'event.second' });
    },
  };
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [binding('worker')],
    plugins: [slowSubscriber, fastSubscriber, publisher],
  });

  await firstStarted.promise;
  await fastDeliveryComplete.promise;
  assert.deepEqual(slowEvents, ['publisher:event.first']);
  assert.deepEqual(fastEvents, ['publisher:event.first', 'publisher:event.second']);
  releaseFirst.resolve();
  await slowDeliveryComplete.promise;
  assert.deepEqual(slowEvents, ['publisher:event.first', 'publisher:event.second']);
  assert.deepEqual(fastEvents, ['publisher:event.first', 'publisher:event.second']);
  await studio.shutdown();
});

test('Studio releases event subscriptions with their Plugin lifecycle owner', async () => {
  let subscriberStopped = false;
  let deliveryAfterStop = false;
  let publisherContext: Parameters<StudioPlugin['start']>[0] | undefined;
  const publisher: StudioPlugin = {
    name: 'publisher',
    toolkits: [],
    start: (context) => {
      publisherContext = context;
    },
    stop: () => {
      publisherContext?.notify({ type: 'publisher.stopping' });
    },
  };
  const subscriber: StudioPlugin = {
    name: 'subscriber',
    toolkits: [],
    start: (context) => {
      // Intentionally do not keep or invoke the returned unsubscribe function.
      context.subscribe(() => {
        if (subscriberStopped) deliveryAfterStop = true;
      });
    },
    stop: () => {
      subscriberStopped = true;
    },
  };
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [binding('worker')],
    plugins: [publisher, subscriber],
  });

  await studio.shutdown();
  assert.equal(deliveryAfterStop, false);
});

test('Studio shutdown does not wait for a stalled event subscriber', async () => {
  const handlerStarted = deferred();
  const neverSettles = new Promise<void>(() => undefined);
  const subscriber: StudioPlugin = {
    name: 'subscriber',
    toolkits: [],
    start: (context) => {
      context.subscribe(async () => {
        handlerStarted.resolve();
        await neverSettles;
      });
    },
  };
  const publisher: StudioPlugin = {
    name: 'publisher',
    toolkits: [],
    start: (context) => {
      context.notify({ type: 'event.stalled' });
    },
  };
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [binding('worker')],
    plugins: [subscriber, publisher],
  });

  await handlerStarted.promise;
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

test('shutdown rejects new dispatches without owning accepted Pet execution', async () => {
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [binding('worker')],
  });
  await studio.dispatch({ petId: 'worker', request: 'accepted' });
  await studio.shutdown();
  await assert.rejects(
    () => studio.dispatch({ petId: 'worker', request: 'too late' }),
    /already shut down/,
  );
});
