import assert from 'node:assert/strict';
import { test } from 'node:test';

import { StudioRequestHandler } from './StudioRequestHandler';
import type {
  Studio,
  StudioDispatchRequest,
  StudioEventHandler,
  StudioInvocationEvent,
  StudioInvocationEventHandler,
} from '../studioContract';

type Peer = { send: (message: unknown) => boolean };

function createPeer(sent: unknown[]): Peer {
  return { send: (message) => { sent.push(message); return true; } };
}

type TestStudio = Studio & {
  lastDispatch: () => StudioDispatchRequest | undefined;
  emitInvocation: (event: StudioInvocationEvent) => void;
};

function fakeStudio(overrides: Partial<Studio> = {}): TestStudio {
  const eventHandlers = new Set<StudioEventHandler>();
  const invocationHandlers = new Set<StudioInvocationEventHandler>();
  const receiptInvocationHandlers = new Map<string, Set<StudioInvocationEventHandler>>();
  let dispatched: StudioDispatchRequest | undefined;
  return {
    entryPetId: 'pet-a',
    dispatch: async (input) => {
      dispatched = input;
      return {
        petId: input.petId,
        threadId: 'studio:s1:pet:pet-a',
        invocationId: 'invocation-1',
        metadata: input.metadata,
        onInvocation: (handler) => {
          const handlers = receiptInvocationHandlers.get('invocation-1') ?? new Set();
          handlers.add(handler);
          receiptInvocationHandlers.set('invocation-1', handlers);
          return () => handlers.delete(handler);
        },
        completion: Promise.resolve({
          petId: input.petId,
          threadId: 'studio:s1:pet:pet-a',
          invocationId: 'invocation-1',
          status: 'completed',
          metadata: input.metadata,
        }),
      };
    },
    onInvocation: (handler) => {
      invocationHandlers.add(handler);
      return () => invocationHandlers.delete(handler);
    },
    notify: (event) => { for (const handler of eventHandlers) void handler(event); },
    subscribe: (handler) => {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    listPets: () => [],
    shutdown: async () => undefined,
    ...overrides,
    lastDispatch: () => dispatched,
    emitInvocation: (event) => {
      for (const handler of invocationHandlers) void handler(event);
      for (const handler of receiptInvocationHandlers.get(event.invocationId) ?? []) {
        void handler(event);
      }
    },
  };
}

function handlerWith(studio: Studio) {
  const sent: unknown[] = [];
  const handler = new StudioRequestHandler<Peer>({
    studio,
    outbound: {
      send: (peer, message) => peer.send(message),
    },
  });
  return { handler, sent };
}

test('a Studio dispatch returns Pet, thread, and invocation identity', async () => {
  const studio = fakeStudio();
  const { handler, sent } = handlerWith(studio);
  await handler.handleStudioRequest(createPeer(sent), {
    type: 'studio.dispatch',
    deliveryId: 'delivery-1',
    petId: 'pet-a',
    input: { kind: 'request', request: 'plan this' },
  });

  const dispatched = studio.lastDispatch();
  assert.deepEqual(dispatched?.input, { kind: 'request', request: 'plan this' });
  assert.equal(dispatched?.petId, 'pet-a');
  assert.equal(dispatched?.metadata, undefined);
  assert.deepEqual(sent[0], {
    type: 'studio.accepted',
    deliveryId: 'delivery-1',
    petId: 'pet-a',
    threadId: 'studio:s1:pet:pet-a',
    invocationId: 'invocation-1',
  });
});

test('acceptance is delivered before a receipt replays current invocation state', async () => {
  const studio = fakeStudio({
    dispatch: async (input) => {
      const busy: StudioInvocationEvent = {
        petId: input.petId,
        threadId: 'studio:s1:pet:pet-a',
        invocationId: 'invocation-1',
        status: 'busy',
        metadata: input.metadata,
      };
      return {
        petId: input.petId,
        threadId: 'studio:s1:pet:pet-a',
        invocationId: 'invocation-1',
        metadata: input.metadata,
        onInvocation: (handler) => {
          void handler(busy);
          return () => undefined;
        },
        completion: new Promise(() => undefined),
      };
    },
  });
  const { handler, sent } = handlerWith(studio);
  await handler.handleStudioRequest(createPeer(sent), {
    type: 'studio.dispatch',
    deliveryId: 'delivery-1',
    petId: 'pet-a',
    input: { kind: 'request', request: 'go' },
  });

  assert.deepEqual(sent.map((message) => (message as { type: string }).type), [
    'studio.accepted',
    'studio.invocation',
  ]);
});

test('a canonical Studio request targets a Pet and carries typed resume input opaquely', async () => {
  const studio = fakeStudio();
  const { handler, sent } = handlerWith(studio);
  await handler.handleStudioRequest(createPeer(sent), {
    type: 'studio.dispatch',
    deliveryId: 'delivery-resume-1',
    petId: 'pet-b',
    input: {
      kind: 'resume_interrupt',
      interruptId: 'interrupt-1',
      payload: {
        kind: 'human_review_response',
        responses: [{ interactionId: 'review-1', selectedOptionId: 'approve' }],
      },
    },
    metadata: { taskId: 'task-1', transportRouteId: 'producer-owned' },
    idempotencyKey: 'resume-task-1',
  });

  const dispatched = studio.lastDispatch();
  assert.equal(dispatched?.petId, 'pet-b');
  assert.equal(dispatched?.input.kind, 'resume_interrupt');
  assert.equal(dispatched?.idempotencyKey, 'resume-task-1');
  assert.deepEqual(dispatched?.metadata, {
    taskId: 'task-1',
    transportRouteId: 'producer-owned',
  });
  assert.deepEqual(sent[0], {
    type: 'studio.accepted',
    deliveryId: 'delivery-resume-1',
    petId: 'pet-b',
    threadId: 'studio:s1:pet:pet-a',
    invocationId: 'invocation-1',
    metadata: { taskId: 'task-1', transportRouteId: 'producer-owned' },
  });
});

test('receipt-scoped invocation events expose pending interrupt without transport metadata', async () => {
  const studio = fakeStudio();
  const { handler, sent } = handlerWith(studio);
  await handler.handleStudioRequest(createPeer(sent), {
    type: 'studio.dispatch',
    deliveryId: 'delivery-1',
    petId: 'pet-a',
    input: { kind: 'request', request: 'go' },
  });
  studio.emitInvocation({
    petId: 'pet-a',
    threadId: 'studio:s1:pet:pet-a',
    invocationId: 'invocation-1',
    status: 'pending_interrupt',
    metadata: { taskId: 'task-1' },
    pendingInterrupt: {
      interruptId: 'interrupt-1',
      payload: { kind: 'human_review', interactions: [] },
    },
  });

  const progress = sent.at(-1) as {
    type: string;
    deliveryId: string;
    status: string;
    invocationId: string;
    metadata: Record<string, unknown>;
    pendingInterrupt: { interruptId: string };
  };
  assert.equal(progress.type, 'studio.invocation');
  assert.equal(progress.deliveryId, 'delivery-1');
  assert.equal(progress.status, 'pending_interrupt');
  assert.equal(progress.invocationId, 'invocation-1');
  assert.deepEqual(progress.metadata, { taskId: 'task-1' });
  assert.equal(progress.pendingInterrupt.interruptId, 'interrupt-1');
});

test('an idempotent transport retry receives the existing invocation terminal result', async () => {
  const studio = fakeStudio({
    dispatch: async () => ({
      petId: 'pet-a',
      threadId: 'studio:s1:pet:pet-a',
      invocationId: 'invocation-existing',
      metadata: { taskId: 'task-1' },
      onInvocation: (handler) => {
        void handler({
          petId: 'pet-a',
          threadId: 'studio:s1:pet:pet-a',
          invocationId: 'invocation-existing',
          status: 'completed',
          output: 'already complete',
          metadata: { taskId: 'task-1' },
        });
        return () => undefined;
      },
      completion: Promise.resolve({
        petId: 'pet-a',
        threadId: 'studio:s1:pet:pet-a',
        invocationId: 'invocation-existing',
        status: 'completed',
        output: 'already complete',
        metadata: { taskId: 'task-1' },
      }),
    }),
  });
  const { handler, sent } = handlerWith(studio);

  await handler.handleStudioRequest(createPeer(sent), {
    type: 'studio.dispatch',
    deliveryId: 'delivery-retry',
    petId: 'pet-a',
    input: { kind: 'request', request: 'same request' },
    idempotencyKey: 'dispatch-1',
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const progress = sent.at(-1) as {
    deliveryId: string;
    status: string;
    invocationId: string;
    output: string;
    metadata: Record<string, unknown>;
  };
  assert.equal(progress.deliveryId, 'delivery-retry');
  assert.equal(progress.status, 'completed');
  assert.equal(progress.invocationId, 'invocation-existing');
  assert.equal(progress.output, 'already complete');
  assert.deepEqual(progress.metadata, { taskId: 'task-1' });
});

test('a dispatch error returns studio_error and releases its route', async () => {
  const studio = fakeStudio({
    dispatch: async () => { throw new Error('dispatch boom'); },
  });
  const { handler, sent } = handlerWith(studio);
  await handler.handleStudioRequest(createPeer(sent), {
    type: 'studio.dispatch',
    deliveryId: 'delivery-1',
    petId: 'pet-a',
    input: { kind: 'request', request: 'go' },
  });
  assert.deepEqual(sent.at(-1), {
    type: 'studio.error',
    deliveryId: 'delivery-1',
    message: 'dispatch boom',
  });
});

test('disconnect drops only that peer routes while the resident Studio remains alive', async () => {
  const studio = fakeStudio();
  const { handler, sent } = handlerWith(studio);
  const peer = createPeer([]);
  await handler.handleStudioRequest(peer, {
    type: 'studio.dispatch',
    deliveryId: 'delivery-1',
    petId: 'pet-a',
    input: { kind: 'request', request: 'go' },
  });
  handler.rejectDisconnected(peer);
  studio.emitInvocation({
    petId: 'pet-a',
    threadId: 'studio:s1:pet:pet-a',
    invocationId: 'invocation-1',
    status: 'completed',
  });
  assert.deepEqual(sent, []);
});
