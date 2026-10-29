import assert from 'node:assert/strict';
import test from 'node:test';
import type { PetDispatchPort, PetSessionPort } from 'pinpawo/host-runtime';

import { prepareStudio, type CreateStudioInput } from './createStudio';
import { StudioPetError } from './pets/studioPets';
import { StudioPetUnavailableError, type StudioPlugin, type StudioPluginContext } from './studioContract';
import type { StudioPetRuntime } from './types';

type StudioPetBinding = {
  registration: { petId: string; name: string };
  dispatch: PetDispatchPort;
  sessions?: PetSessionPort;
};

/** A Studio whose Pets are the given live ports, each its own definition, created before Plugins start. */
async function createStudio(input: Omit<CreateStudioInput, 'definitions' | 'assemblePet'> & { pets: StudioPetBinding[] }) {
  const { pets, ...rest } = input;
  const prepared = prepareStudio({
    ...rest,
    definitions: pets.map(({ registration }) => ({ definitionId: registration.petId, name: registration.name })),
    assemblePet: async ({ petId }) => {
      const pet = pets.find(({ registration }) => registration.petId === petId)!;
      return { dispatch: pet.dispatch, ...(pet.sessions ? { sessions: pet.sessions } : {}), close: async () => undefined };
    },
  });
  await prepared.restorePets();
  for (const { registration } of pets) {
    await prepared.studio.pets.create({ petId: registration.petId, definitionId: registration.petId, name: registration.name });
  }
  await prepared.activatePlugins();
  return prepared.studio;
}

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
    getQueueSnapshot: () => ({
      state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0,
    }),
    onQueueChange: () => () => undefined,
    onDispatchLifecycle: () => () => undefined,
    dispatch: async ({ request }) => { await run(request); },
  };
  return {
    registration: {
      petId,
      name: petId.toUpperCase(),
    },
    dispatch: port,
  };
}

test('Studio dispatches request-only input and returns no thread or continuation data', async () => {
  const seen: unknown[] = [];
  const events: unknown[] = [];
  const studio = await createStudio({
    studioId: 's1',
    pets: [binding('worker', (request) => {
      seen.push(request);
    })],
  });
  studio.subscribe((event) => { events.push(event); });

  const receipt = await studio.dispatch({ petId: 'worker', request: 'draft' });
  assert.deepEqual(seen, ['draft']);
  assert.deepEqual(Object.keys(receipt).sort(), ['invocationId', 'petId']);
  assert.equal('completion' in receipt, false);
  assert.equal('status' in receipt, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, [{
    eventId: (events[0] as { eventId: string }).eventId,
    type: 'dispatch.accepted',
    source: 'studio',
    occurredAt: (events[0] as { occurredAt: string }).occurredAt,
    payload: {
      invocationId: receipt.invocationId,
      petId: 'worker',
      request: 'draft',
      producer: 'studio',
    },
  }]);
  await studio.shutdown();
});

test('Studio relays resident dispatch lifecycle observations without owning execution', async () => {
  const events: unknown[] = [];
  let lifecycleListener: Parameters<PetDispatchPort['onDispatchLifecycle']>[0] | undefined;
  const port: PetDispatchPort = {
    getQueueSnapshot: () => ({
      state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0,
    }),
    onQueueChange: () => () => undefined,
    onDispatchLifecycle: (listener) => {
      lifecycleListener = listener;
      return () => {
        if (lifecycleListener === listener) lifecycleListener = undefined;
      };
    },
    dispatch: async ({ request, dispatchId }) => {
      assert.ok(dispatchId);
      lifecycleListener?.({ dispatchId, request, state: 'queued' });
      lifecycleListener?.({ dispatchId, request, requestId: 'host-1', state: 'running' });
      lifecycleListener?.({ dispatchId, request, requestId: 'host-1', state: 'message', message: {
        type: 'message.completed', messageId: 'm1', role: 'assistant', text: 'draft ready',
      } });
      lifecycleListener?.({
        dispatchId,
        request,
        requestId: 'host-1',
        state: 'failed',
        error: 'Connection error',
      });
    },
  };
  const studio = await createStudio({
    studioId: 's1',
    pets: [{
      registration: { petId: 'worker', name: 'WORKER' },
      dispatch: port,
    }],
  });
  studio.subscribe((event) => { events.push(event); });

  const receipt = await studio.dispatch({ petId: 'worker', request: 'draft' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(events.map((event) => ({
    type: (event as { type: string }).type,
    source: (event as { source: string }).source,
  })), [
    { type: 'dispatch.queued', source: 'resident-pet' },
    { type: 'dispatch.running', source: 'resident-pet' },
    { type: 'dispatch.message', source: 'resident-pet' },
    { type: 'dispatch.failed', source: 'resident-pet' },
    { type: 'dispatch.accepted', source: 'studio' },
  ]);
  assert.deepEqual((events[2] as { payload: { message?: unknown } }).payload.message, {
    type: 'message.completed', messageId: 'm1', role: 'assistant', text: 'draft ready',
  });
  assert.deepEqual((events[3] as { payload: unknown }).payload, {
    invocationId: receipt.invocationId,
    petId: 'worker',
    request: 'draft',
    requestId: 'host-1',
    error: 'Connection error',
  });
  await studio.shutdown();
  assert.equal(lifecycleListener, undefined);
});

test('Studio delegates queue ownership to each live Pet dispatch port', async () => {
  const events: string[] = [];
  const studio = await createStudio({
    studioId: 's1',
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
  let acceptedEvents = 0;
  const studio = await createStudio({
    studioId: 's1',
    pets: [binding('worker', () => {
      calls += 1;
    })],
  });
  studio.subscribe((event) => {
    if (event.type === 'dispatch.accepted') acceptedEvents += 1;
  });
  const request = { petId: 'worker', request: 'work', idempotencyKey: 'task-1' };
  const first = await studio.dispatch(request);
  const second = await studio.dispatch(request);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(first, second);
  assert.equal(calls, 1);
  assert.equal(acceptedEvents, 1);
  await studio.shutdown();
});

test('dispatch owns simultaneous admission deduplication and isolates producer keys', async () => {
  const gate = deferred();
  let calls = 0;
  const plugins: StudioPlugin[] = [];
  const receipts: Array<Promise<unknown>> = [];
  for (const name of ['channel', 'http']) plugins.push({ name, toolkits: [], start: context => {
    receipts.push(context.dispatch({ petId: 'worker', request: 'same text', idempotencyKey: 'same-key' }));
  } });
  const studio = await createStudio({ studioId: 's', plugins,
    pets: [binding('worker', async () => { calls++; await gate.promise; })] });
  const request = { petId: 'worker', request: 'work', idempotencyKey: 'concurrent' };
  const first = studio.dispatch(request);
  const second = studio.dispatch(request);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 3, 'two producers are distinct, simultaneous retries share one port admission');
  gate.resolve();
  assert.equal(await first, await second);
  await Promise.all(receipts);
  await studio.shutdown();
});

test('dispatch rejects when the Pet cannot accept the input', async () => {
  const studio = await createStudio({
    studioId: 's1',
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
    pets: [binding('worker')],
  });
  assert.deepEqual(studio.listPets(), [{
    petId: 'worker',
    name: 'WORKER',
    definitionId: 'worker',
  }]);
  await studio.shutdown();
});

test('Plugin receives dispatch/event/hook context without a Pet runtime reference', async () => {
  let pluginContextKeys: string[] = [];
  let allocated: string[] = [];
  const receivedEvents: Array<[string, string]> = [];
  const plugin: StudioPlugin = {
    name: 'scheduler',
    toolkits: [],
    start: async (context) => {
      pluginContextKeys = Object.keys(context).sort();
      allocated = [context.allocateSessionId('worker'), context.allocateSessionId('worker')];
      context.subscribe((event) => {
        receivedEvents.push([event.type, event.source]);
      });
      context.notify({ type: 'schedule.ready' });
      await context.dispatch({ petId: 'worker', request: 'run' });
    },
  };
  const studio = await createStudio({
    studioId: 's1',
    pets: [binding('worker')],
    plugins: [plugin],
  });
  assert.deepEqual(pluginContextKeys, [
    'allocateSessionId',
    'clients',
    'dispatch',
    'hooks',
    'listDispatchQueues',
    'listPets',
    'models',
    'notify',
    'petSessions',
    'pets',
    'storage',
    'subscribe',
  ]);
  // A reserved name only: each call is a new id for that Pet.
  assert.match(allocated[0]!, /^worker:/);
  assert.notEqual(allocated[0], allocated[1]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Activation is announced once, after every Plugin has started.
  assert.deepEqual(receivedEvents, [
    ['schedule.ready', 'scheduler'],
    ['dispatch.accepted', 'studio'],
    ['plugins.activated', 'studio'],
  ]);
  await studio.shutdown();
});

test('Plugin session access routes to the exact Pet and never to another', async () => {
  const calls: unknown[] = [];
  const sessions: PetSessionPort = {
    snapshot: async (sessionId) => { calls.push(['snapshot', sessionId]); return { sessionId } as never; },
    observe: async (sessionId) => { calls.push(['observe', sessionId]); return () => undefined; },
    review: async (sessionId, request) => { calls.push(['review', sessionId, request.requestId]); },
  };
  let access: StudioPluginContext['petSessions'] | undefined;
  const studio = await createStudio({
    studioId: 's1',
    pets: [{ ...binding('worker'), sessions }, binding('dispatch-only')],
    plugins: [{ name: 'http', toolkits: [], start: (context) => { access = context.petSessions; } }],
  });
  assert.ok(access);
  await access.snapshot('worker', 'worker:0000000a');
  await access.observe('worker', 'worker:0000000a', () => undefined);
  await access.review('worker', 'worker:0000000a', { requestId: 'r', interruptId: 'i', value: { decisions: [] } });
  assert.deepEqual(calls, [
    ['snapshot', 'worker:0000000a'],
    ['observe', 'worker:0000000a'],
    ['review', 'worker:0000000a', 'r'],
  ]);
  await assert.rejects(access.snapshot('dispatch-only', 's'), StudioPetUnavailableError);
  await assert.rejects(access.snapshot('missing', 's'), StudioPetUnavailableError);
  await studio.shutdown();
});

test('prepared Studio does not start Plugins until the Host activates them', async () => {
  const events: string[] = [];
  const prepared = prepareStudio({
    studioId: 's1',
    definitions: [],
    assemblePet: async () => { throw new Error('no Pets'); },
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
        if (event.source !== 'publisher') return;
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
        if (event.source !== 'publisher') return;
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
    pets: [binding('worker')],
    plugins: [first, second],
  }), /boom/);
  assert.deepEqual(events, ['first:start', 'second:start', 'second:stop', 'first:stop']);
});

test('shutdown rejects new dispatches without owning accepted Pet execution', async () => {
  const studio = await createStudio({
    studioId: 's1',
    pets: [binding('worker')],
  });
  await studio.dispatch({ petId: 'worker', request: 'accepted' });
  await studio.shutdown();
  await assert.rejects(
    () => studio.dispatch({ petId: 'worker', request: 'too late' }),
    /already shut down/,
  );
});

test('Plugins read model profiles through context.models, and a Studio without them refuses', async () => {
  const endpoint = { profileId: 'small', baseUrl: 'https://models.test/v1', apiKey: 'k', model: 'small-1' };
  let models: StudioPluginContext['models'] | undefined;
  const plugin: StudioPlugin = { name: 'reader', toolkits: [], start: (context) => { models = context.models; } };
  const studio = await createStudio({
    studioId: 'models', pets: [binding('worker')], plugins: [plugin],
    models: { resolve: (profileId) => ({ ...endpoint, profileId: profileId ?? endpoint.profileId }) },
  });
  assert.deepEqual(models?.resolve(), endpoint);
  assert.equal(models?.resolve('other').profileId, 'other');
  await studio.shutdown();

  const bare = await createStudio({ studioId: 'bare', pets: [binding('worker')], plugins: [plugin] });
  assert.throws(() => models!.resolve(), /has no model profiles/);
  await bare.shutdown();
});

/** Pets assembled from definitions: every assemble call and close is recorded. */
function instanceStudio(input: { storage?: CreateStudioInput['storage']; failAssemble?: (petId: string) => boolean } = {}) {
  const assembled: string[] = [];
  const closed: string[] = [];
  const dispatched: Array<[string, string]> = [];
  const prepared = prepareStudio({
    studioId: 'instances',
    ...(input.storage ? { storage: input.storage } : {}),
    definitions: [{ definitionId: 'developer', name: 'Developer' }, { definitionId: 'reviewer', name: 'Reviewer' }],
    assemblePet: async ({ petId }): Promise<StudioPetRuntime> => {
      if (input.failAssemble?.(petId)) throw new Error(`cannot assemble ${petId}`);
      assembled.push(petId);
      const { dispatch } = binding(petId, (request) => { dispatched.push([petId, request]); });
      return { dispatch, close: async () => { closed.push(petId); } };
    },
  });
  return { prepared, studio: prepared.studio, assembled, closed, dispatched };
}

test('two Pets from one definition are separate: own runtime, own address', async () => {
  const { prepared, studio, assembled, dispatched } = instanceStudio();
  await prepared.activatePlugins();
  await studio.pets.create({ petId: 'dev-a', definitionId: 'developer', name: 'Dev' });
  await studio.pets.create({ petId: 'dev-b', definitionId: 'developer', name: 'Dev' });
  assert.deepEqual(assembled, ['dev-a', 'dev-b']);
  assert.deepEqual(studio.listPets(), [
    { petId: 'dev-a', name: 'Dev', definitionId: 'developer' },
    { petId: 'dev-b', name: 'Dev', definitionId: 'developer' },
  ]);
  await studio.dispatch({ petId: 'dev-b', request: 'only b' });
  assert.deepEqual(dispatched, [['dev-b', 'only b']]);
  await assert.rejects(studio.dispatch({ petId: 'developer', request: 'by definition' }), (error: unknown) => (
    error instanceof StudioPetError && error.code === 'not_found'
  ));
  await studio.shutdown();
});

test('Pet creation checks the id, the definition and uniqueness, and frees the id when assembly fails', async () => {
  let fail = true;
  const { prepared, studio } = instanceStudio({ failAssemble: () => fail });
  await prepared.activatePlugins();
  const code = (expected: string) => (error: unknown) => error instanceof StudioPetError && error.code === expected;
  await assert.rejects(studio.pets.create({ petId: 'bad id', definitionId: 'developer', name: 'X' }), code('invalid'));
  await assert.rejects(studio.pets.create({ petId: 'x', definitionId: 'ghost', name: 'X' }), code('invalid'));
  await assert.rejects(studio.pets.create({ petId: 'x', definitionId: 'developer', name: ' ' }), code('invalid'));
  await assert.rejects(studio.pets.create({ petId: 'x', definitionId: 'developer', name: 'X' }), /cannot assemble x/);
  assert.equal(await studio.pets.get('x'), undefined);
  fail = false;
  await studio.pets.create({ petId: 'x', definitionId: 'developer', name: 'X' });
  await assert.rejects(studio.pets.create({ petId: 'x', definitionId: 'reviewer', name: 'Y' }), code('exists'));
  assert.deepEqual(studio.pets.definitions().map(({ definitionId }) => definitionId), ['developer', 'reviewer']);
  await studio.shutdown();
});

test('renaming changes the display name everywhere and publishes it', async () => {
  const { prepared, studio } = instanceStudio();
  const events: string[] = [];
  studio.subscribe((event) => { if (event.type.startsWith('pet.')) events.push(event.type); });
  await prepared.activatePlugins();
  await studio.pets.create({ petId: 'dev', definitionId: 'developer', name: 'Dev' });
  const renamed = await studio.pets.rename('dev', 'Developer One');
  assert.equal(renamed.name, 'Developer One');
  assert.equal(studio.listPets()[0]!.name, 'Developer One');
  assert.equal((await studio.pets.get('dev'))?.name, 'Developer One');
  await assert.rejects(studio.pets.rename('nobody', 'X'), (error: unknown) => (
    error instanceof StudioPetError && error.code === 'not_found'
  ));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ['pet.created', 'pet.renamed']);
  await studio.shutdown();
});

test('lifecycle events a Pet emits while its runtime closes still reach Studio', async () => {
  const seen: string[] = [];
  const prepared = prepareStudio({
    studioId: 'closing',
    definitions: [{ definitionId: 'developer', name: 'Developer' }],
    assemblePet: async ({ petId }): Promise<StudioPetRuntime> => {
      const listeners = new Set<Parameters<PetDispatchPort['onDispatchLifecycle']>[0]>();
      const { dispatch } = binding(petId);
      return {
        dispatch: {
          ...dispatch,
          onDispatchLifecycle: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        },
        close: async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          for (const listener of listeners) {
            listener({ state: 'completed', dispatchId: 'last', request: 'r', reply: 'done' } as Parameters<typeof listener>[0]);
          }
        },
      };
    },
  });
  prepared.studio.subscribe((event) => { seen.push(event.type); });
  await prepared.activatePlugins();
  await prepared.studio.pets.create({ petId: 'dev', definitionId: 'developer', name: 'Dev' });
  await prepared.studio.shutdown();
  assert.ok(seen.includes('dispatch.completed'), seen.join(','));
});

test('a restarted Studio assembles the same Pets once', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const root = await mkdtemp(path.join(tmpdir(), 'studio-pets-restart-'));
  const storage = { kind: 'sqlite' as const, path: path.join(root, 'studio.sqlite') };
  try {
    const first = instanceStudio({ storage });
    await first.prepared.activatePlugins();
    await first.studio.pets.create({ petId: 'dev-a', definitionId: 'developer', name: 'A' });
    await first.studio.pets.create({ petId: 'dev-b', definitionId: 'developer', name: 'B' });
    await first.studio.pets.create({ petId: 'rev', definitionId: 'reviewer', name: 'R' });
    await first.studio.shutdown();
    assert.deepEqual(first.closed.sort(), ['dev-a', 'dev-b', 'rev']);

    const second = instanceStudio({ storage });
    await second.prepared.restorePets();
    await second.prepared.activatePlugins();
    assert.deepEqual(second.assembled, ['dev-a', 'dev-b', 'rev']);
    assert.deepEqual(second.studio.listPets().map(({ petId }) => petId), ['dev-a', 'dev-b', 'rev']);
    await second.studio.dispatch({ petId: 'dev-a', request: 'continue' });
    assert.deepEqual(second.dispatched, [['dev-a', 'continue']]);
    await second.studio.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a Studio refuses to start when a Pet names a definition it no longer lists', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const root = await mkdtemp(path.join(tmpdir(), 'studio-pets-definition-'));
  const storage = { kind: 'sqlite' as const, path: path.join(root, 'studio.sqlite') };
  try {
    const first = instanceStudio({ storage });
    await first.prepared.activatePlugins();
    await first.studio.pets.create({ petId: 'rev', definitionId: 'reviewer', name: 'R' });
    await first.studio.shutdown();

    const narrowed = prepareStudio({
      studioId: 'instances', storage,
      definitions: [{ definitionId: 'developer', name: 'Developer' }],
      assemblePet: async () => { throw new Error('not reached'); },
    });
    await assert.rejects(narrowed.restorePets(), /Pet "rev" uses definition "reviewer"/);
    await narrowed.studio.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
