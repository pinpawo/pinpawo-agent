import assert from 'node:assert/strict';
import { AIMessage } from '@langchain/core/messages';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  reduceSession,
  type AgentServerMessage,
} from '@pinpawo/agent-session';
import {
  buildReviewSpec,
  type CapabilityArtifactStore,
} from '@pinpawo/pet-agent';

import {
  createResidentPetHost,
  ResidentPetCoordinator,
  type AgentSessionPeer,
  type PetDispatchState,
} from './residentPetHost';
import { FileSaver } from './fileSaver';
import { buildLocalAgentRuntimeConfig } from './runtimeConfig';
import { createTestModelProfiles } from './testing/modelProfiles';
import { HostToolkitInventoryStore } from './toolkits/toolkitInventory';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

test('Coordinator keeps the active operation non-preemptive then drains conversation first', async () => {
  let settledState: PetDispatchState = 'open';
  const coordinator = new ResidentPetCoordinator({
    readSettledState: () => settledState,
  });
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const events: string[] = [];

  const firstDispatch = coordinator.enqueueDispatch(async () => {
    events.push('dispatch-1:start');
    firstStarted.resolve();
    await releaseFirst.promise;
    events.push('dispatch-1:end');
  });
  await firstStarted.promise;

  const secondDispatch = coordinator.enqueueDispatch(async () => {
    events.push('dispatch-2');
  });
  const firstConversation = coordinator.enqueueConversation(async () => {
    events.push('conversation-1');
  });
  const secondConversation = coordinator.enqueueConversation(async () => {
    events.push('conversation-2');
  });

  assert.deepEqual(coordinator.getQueueSnapshot(), {
    state: 'busy',
    activeOperation: 'dispatch',
    queuedConversations: 2,
    queuedDispatches: 1,
  });
  assert.deepEqual(events, ['dispatch-1:start']);
  releaseFirst.resolve();
  await Promise.all([
    firstDispatch,
    secondDispatch,
    firstConversation,
    secondConversation,
  ]);
  assert.deepEqual(events, [
    'dispatch-1:start',
    'dispatch-1:end',
    'conversation-1',
    'conversation-2',
    'dispatch-2',
  ]);
});

test('state listeners cannot reenter admission while an operation is becoming active', async () => {
  let settledState: PetDispatchState = 'open';
  const coordinator = new ResidentPetCoordinator({
    readSettledState: () => settledState,
  });
  const dispatchStarted = deferred();
  const releaseDispatch = deferred();
  const events: string[] = [];
  let queuedFromListener: Promise<void> | undefined;
  coordinator.onStateChange((state) => {
    if (state !== 'busy' || queuedFromListener) return;
    queuedFromListener = coordinator.enqueueConversation(async () => {
      events.push('conversation');
    });
  });

  const dispatch = coordinator.enqueueDispatch(async () => {
    events.push('dispatch:start');
    dispatchStarted.resolve();
    await releaseDispatch.promise;
    events.push('dispatch:end');
  });
  await dispatchStarted.promise;
  assert.deepEqual(events, ['dispatch:start']);

  releaseDispatch.resolve();
  await Promise.all([dispatch, queuedFromListener]);
  assert.deepEqual(events, ['dispatch:start', 'dispatch:end', 'conversation']);
});

test('waiting state holds dispatch while conversation can reopen the gate', async () => {
  let settledState: PetDispatchState = 'waiting';
  const states: PetDispatchState[] = [];
  const events: string[] = [];
  const coordinator = new ResidentPetCoordinator({
    initialState: 'waiting',
    readSettledState: () => settledState,
  });
  coordinator.onStateChange((state) => states.push(state));

  const dispatch = coordinator.enqueueDispatch(async () => {
    events.push('dispatch');
  });
  await Promise.resolve();
  assert.equal(events.length, 0);

  await coordinator.enqueueConversation(async () => {
    events.push('conversation');
    settledState = 'open';
  });
  await dispatch;

  assert.deepEqual(events, ['conversation', 'dispatch']);
  assert.deepEqual(states, ['busy', 'open', 'busy', 'open']);
});

test('a submitted dispatch refreshes a stale waiting state before it is held', async () => {
  const coordinator = new ResidentPetCoordinator({
    initialState: 'waiting',
    readSettledState: () => 'open',
  });
  const dispatched = deferred();

  coordinator.submitDispatch(async () => {
    dispatched.resolve();
  });

  await dispatched.promise;
  await waitFor(
    () => coordinator.getQueueSnapshot().state === 'open'
      && coordinator.getQueueSnapshot().queuedDispatches === 0,
    'submitted dispatch did not refresh the stale waiting gate',
  );
});

test('a queued dispatch reads the active conversation thread only when it starts', async () => {
  let activeThread = 'thread-old';
  const coordinator = new ResidentPetCoordinator({ readSettledState: () => 'open' });
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const observedThreads: string[] = [];
  const first = coordinator.enqueueDispatch(async () => {
    observedThreads.push(activeThread);
    firstStarted.resolve();
    await releaseFirst.promise;
  });
  await firstStarted.promise;
  const second = coordinator.enqueueDispatch(async () => {
    observedThreads.push(activeThread);
  });
  const switchConversation = coordinator.enqueueConversation(async () => {
    activeThread = 'thread-new';
  });

  releaseFirst.resolve();
  await Promise.all([first, switchConversation, second]);

  assert.deepEqual(observedThreads, ['thread-old', 'thread-new']);
});

test('Coordinator close cancels queued work and waits for the active operation', async () => {
  let settledState: PetDispatchState = 'open';
  const coordinator = new ResidentPetCoordinator({
    readSettledState: () => settledState,
  });
  const activeStarted = deferred();
  const releaseActive = deferred();
  const active = coordinator.enqueueDispatch(async () => {
    activeStarted.resolve();
    await releaseActive.promise;
  });
  await activeStarted.promise;
  const queued = coordinator.enqueueDispatch(async () => undefined);
  const closed = coordinator.close();

  await assert.rejects(queued, /closing/i);
  let closeSettled = false;
  void closed.then(() => {
    closeSettled = true;
  });
  await Promise.resolve();
  assert.equal(closeSettled, false);

  releaseActive.resolve();
  await Promise.all([active, closed]);
  assert.equal(closeSettled, true);
  await assert.rejects(
    coordinator.enqueueConversation(async () => undefined),
    /cancelled/i,
  );
});

const testArtifactStore: CapabilityArtifactStore = {
  writeArtifact: async () => { throw new Error('not used'); },
  readArtifact: async () => { throw new Error('not used'); },
  listArtifacts: async () => [],
  deleteThreadArtifacts: async () => undefined,
  getDownloadUri: async (uri) => uri,
};

function peer(messages: unknown[]): AgentSessionPeer {
  return {
    isConnected: () => true,
    send: (message) => {
      messages.push(message);
      return true;
    },
  };
}

test('two resident Pets isolate waiting checkpoints and resume through Agent Session after reconnect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-resident-pets-'));
  const runtimeConfig = buildLocalAgentRuntimeConfig(root);
  const states = new Map<string, {
    messages: AIMessage[];
    pendingInterrupt: ReturnType<typeof buildReviewSpec> | null;
  }>();
  const graphService = {
    readThreadState: async (setup: { input: { threadId?: string } }) => {
      const state = states.get(setup.input.threadId ?? '') ?? {
        messages: [],
        pendingInterrupt: null,
      };
      return {
        messages: state.messages,
        pendingInterrupt: state.pendingInterrupt
          ? { interruptId: 'interrupt-1', reviews: [state.pendingInterrupt] }
          : null,
        hasPendingContinuation: state.pendingInterrupt !== null,
        currentPlan: null,
      };
    },
  };
  const checkpointer = new FileSaver(runtimeConfig.checkpointPath);
  const createPet = async (petId: string) => createResidentPetHost({
    petId,
    petName: 'Same display name',
    modelProfiles: createTestModelProfiles(),
    capabilities: [],
    toolkitInventory: new HostToolkitInventoryStore(),
    capabilityArtifactStore: testArtifactStore,
    checkpointer,
    runtimeConfig,
    globalReviewPolicyMode: 'require_authorization',
    autoAuthorizationSafetyLevel: 'strict',
    capabilityRegistryBackend: 'memory',
    sessionStatePath: join(runtimeConfig.stateRoot, `${petId}-sessions.json`),
    graphService: graphService as never,
    runAgentTurn: async ({ request, setup }) => {
      const threadId = setup.input.threadId ?? '';
      const state = states.get(threadId) ?? { messages: [], pendingInterrupt: null };
      if (request.kind === 'user_message') {
        const review = buildReviewSpec({
          id: 'review-1',
          view: { kind: 'plain', body: 'Approve this dispatch?' },
          options: [{
            id: 'approve',
            label: 'Approve',
            decision: { type: 'approve' },
          }],
        });
        states.set(threadId, {
          messages: [new AIMessage('waiting for approval')],
          pendingInterrupt: review,
        });
        return { status: 'waiting_human' };
      }
      states.set(threadId, { ...state, pendingInterrupt: null });
      return { status: 'completed', reply: 'approved' };
    },
  });
  const petA = await createPet('pet-a');
  const petB = await createPet('pet-b');

  try {
    petA.resident.dispatch.dispatch({ request: 'needs review' });
    await waitFor(
      () => petA.resident.dispatch.getQueueSnapshot().state === 'waiting',
      'resident dispatch queue did not enter waiting for human review',
    );
    assert.equal(petA.resident.dispatch.getQueueSnapshot().state, 'waiting');
    assert.equal(petB.resident.dispatch.getQueueSnapshot().state, 'open');

    const firstConnectionMessages: unknown[] = [];
    const firstConnection = peer(firstConnectionMessages);
    await petA.interaction.connect(firstConnection);
    await petA.interaction.disconnect(firstConnection);

    const resumedConnectionMessages: unknown[] = [];
    const resumedConnection = peer(resumedConnectionMessages);
    await petA.interaction.connect(resumedConnection);
    await petA.interaction.handle(resumedConnection, {
      type: 'session.snapshot.get',
      requestId: 'snapshot-waiting',
    });
    const waitingSnapshot = resumedConnectionMessages.find((message) => (
      (message as { type?: string }).type === 'session.snapshot.result'
    )) as { snapshot?: { session?: { pendingInterrupt?: unknown } } } | undefined;
    assert.ok(waitingSnapshot?.snapshot?.session?.pendingInterrupt);

    await petA.interaction.handle(resumedConnection, {
      type: 'human_review_response',
      requestId: 'resume-1',
      interruptId: 'interrupt-1',
      responses: [{ interactionId: 'review-1', selectedOptionId: 'approve' }],
    });
    assert.equal(petA.resident.dispatch.getQueueSnapshot().state, 'open');
    await petA.interaction.disconnect(resumedConnection);

    const finalConnectionMessages: unknown[] = [];
    const finalConnection = peer(finalConnectionMessages);
    await petA.interaction.connect(finalConnection);
    await petA.interaction.handle(finalConnection, {
      type: 'session.snapshot.get',
      requestId: 'snapshot-resumed',
    });
    const resumedSnapshot = finalConnectionMessages.find((message) => (
      (message as { type?: string }).type === 'session.snapshot.result'
    )) as { snapshot?: { session?: { pendingInterrupt?: unknown } } } | undefined;
    assert.equal(resumedSnapshot?.snapshot?.session?.pendingInterrupt, null);
    await petA.interaction.disconnect(finalConnection);
  } finally {
    await Promise.all([petA.close(), petB.close()]);
  }
});

test('dispatch and conversation publish the same Agent Session event stream to observers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-resident-events-'));
  const runtimeConfig = buildLocalAgentRuntimeConfig(root);
  const blockingTurnStarted = deferred();
  let dispatchCallerMetadata: unknown;
  const graphService = {
    readThreadState: async () => ({
      messages: [],
      pendingInterrupt: null,
      hasPendingContinuation: false,
      currentPlan: null,
    }),
  };
  const host = await createResidentPetHost({
    petId: 'pet-events',
    petName: 'pet-events',
    modelProfiles: createTestModelProfiles(),
    capabilities: [],
    toolkitInventory: new HostToolkitInventoryStore(),
    capabilityArtifactStore: testArtifactStore,
    checkpointer: new FileSaver(runtimeConfig.checkpointPath),
    runtimeConfig,
    globalReviewPolicyMode: 'require_authorization',
    autoAuthorizationSafetyLevel: 'strict',
    capabilityRegistryBackend: 'memory',
    sessionStatePath: join(runtimeConfig.stateRoot, 'pet-events-sessions.json'),
    graphService: graphService as never,
    runAgentTurn: async ({ request, setup, emitEvent }) => {
      const text = request.kind === 'user_message' ? request.message : 'resumed';
      if (text === 'from host') {
        dispatchCallerMetadata = AsyncLocalStorageProviderSingleton
          .getRunnableConfig()?.metadata;
      }
      if (text === 'blocking host turn') {
        blockingTurnStarted.resolve();
        await new Promise<void>((resolve) => {
          const signal = setup.input.signal;
          if (!signal || signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { status: 'interrupted' };
      }
      if (text === 'failing host turn') {
        throw new Error('Connection error');
      }
      emitEvent({
        type: 'message.delta',
        requestId: request.requestId,
        messageId: `${request.requestId}-assistant`,
        role: 'assistant',
        text: `handling ${text}`,
      });
      emitEvent({
        type: 'message.completed',
        requestId: request.requestId,
        messageId: `${request.requestId}-assistant`,
        role: 'assistant',
        text: `handled ${text}`,
      });
      return { status: 'completed', reply: `handled ${text}` };
    },
  });
  const sourceMessages: unknown[] = [];
  const observerMessages: unknown[] = [];
  const lifecycleEvents: Array<{ state: string; dispatchId: string; error?: string }> = [];
  const source = peer(sourceMessages);
  const observer = peer(observerMessages);
  await host.interaction.connect(source);
  await host.interaction.connect(observer);
  const stopLifecycleObservation = host.resident.dispatch.onDispatchLifecycle((event) => {
    lifecycleEvents.push({
      state: event.state,
      dispatchId: event.dispatchId,
      ...(event.error ? { error: event.error } : {}),
    });
  });

  try {
    AsyncLocalStorageProviderSingleton.runWithConfig({
      callbacks: [],
      metadata: { caller: 'studio-plugin-run' },
    }, () => {
      host.resident.dispatch.dispatch({ request: 'from host', dispatchId: 'studio-dispatch-1' });
    });
    await waitFor(
      () => observerMessages.some((message) => (
        (message as { event?: { type?: string } }).event?.type === 'message.completed'
      )),
      'resident dispatch did not publish its completed message event',
    );
    for (const messages of [sourceMessages, observerMessages]) {
      const events = messages.flatMap((message) => (
        (message as { type?: string }).type === 'event'
          ? [(message as { event: { type: string; initiator?: string } }).event]
          : []
      ));
      assert.deepEqual(events.map((event) => event.type), [
        'run.started',
        'message.delta',
        'message.completed',
      ]);
      assert.equal(events[0]?.initiator, 'host');
    }
    assert.equal(
      (dispatchCallerMetadata as { caller?: string } | undefined)?.caller,
      undefined,
    );
    assert.deepEqual(lifecycleEvents.slice(0, 3), [
      { state: 'queued', dispatchId: 'studio-dispatch-1' },
      { state: 'running', dispatchId: 'studio-dispatch-1' },
      { state: 'completed', dispatchId: 'studio-dispatch-1' },
    ]);

    host.resident.dispatch.dispatch({
      request: 'failing host turn',
      dispatchId: 'studio-dispatch-failed',
    });
    await waitFor(
      () => lifecycleEvents.some((event) => (
        event.state === 'failed' && event.dispatchId === 'studio-dispatch-failed'
      )),
      'failed resident dispatch did not publish its lifecycle observation',
    );
    assert.deepEqual(lifecycleEvents.at(-1), {
      state: 'failed',
      dispatchId: 'studio-dispatch-failed',
      error: 'Connection error',
    });

    sourceMessages.length = 0;
    observerMessages.length = 0;
    await host.interaction.handle(source, {
      type: 'chat_request',
      requestId: 'client-run-1',
      message: 'from client',
    });
    for (const messages of [sourceMessages, observerMessages]) {
      const events = messages.flatMap((message) => (
        (message as { type?: string }).type === 'event'
          ? [(message as { event: { type: string; initiator?: string } }).event]
          : []
      ));
      assert.deepEqual(events.map((event) => event.type), [
        'run.started',
        'message.delta',
        'message.completed',
      ]);
      assert.equal(events[0]?.initiator, 'client');
    }

    sourceMessages.length = 0;
    observerMessages.length = 0;
    host.resident.dispatch.dispatch({
      request: 'blocking host turn',
    });
    await blockingTurnStarted.promise;
    const startedEnvelope = observerMessages.find((message) => (
      (message as { type?: string; event?: { type?: string } }).event?.type === 'run.started'
    )) as { requestId?: string } | undefined;
    assert.ok(startedEnvelope?.requestId);
    await host.interaction.handle(observer, {
      type: 'run.interrupt',
      requestId: startedEnvelope.requestId,
    });
    await waitFor(
      () => observerMessages.some((message) => (
        (message as { event?: { type?: string } }).event?.type === 'run.interrupted'
      )),
      'interrupted resident dispatch did not publish its runtime event',
    );
    assert.ok(observerMessages.some((message) => (
      (message as { event?: { type?: string } }).event?.type === 'run.interrupted'
    )));
  } finally {
    stopLifecycleObservation();
    await host.close();
  }
});

test('a TUI attaching mid-dispatch snapshots the resident run and projects later events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-resident-late-observer-'));
  const runtimeConfig = buildLocalAgentRuntimeConfig(root);
  const turnStarted = deferred();
  const releaseTurn = deferred();
  const graphService = {
    readThreadState: async () => ({
      messages: [],
      pendingInterrupt: null,
      hasPendingContinuation: false,
      currentPlan: null,
    }),
  };
  const host = await createResidentPetHost({
    petId: 'pet-late-observer',
    petName: 'pet-late-observer',
    modelProfiles: createTestModelProfiles(),
    capabilities: [],
    toolkitInventory: new HostToolkitInventoryStore(),
    capabilityArtifactStore: testArtifactStore,
    checkpointer: new FileSaver(runtimeConfig.checkpointPath),
    runtimeConfig,
    globalReviewPolicyMode: 'require_authorization',
    autoAuthorizationSafetyLevel: 'strict',
    capabilityRegistryBackend: 'memory',
    sessionStatePath: join(runtimeConfig.stateRoot, 'late-observer-sessions.json'),
    graphService: graphService as never,
    runAgentTurn: async ({ request, emitEvent }) => {
      turnStarted.resolve();
      await releaseTurn.promise;
      emitEvent({
        type: 'message.delta',
        requestId: request.requestId,
        messageId: 'late-assistant',
        role: 'assistant',
        text: 'finishing ',
      });
      emitEvent({
        type: 'message.completed',
        requestId: request.requestId,
        messageId: 'late-assistant',
        role: 'assistant',
        text: 'finishing work',
      });
      return { status: 'completed', reply: 'finishing work' };
    },
  });
  const messages: AgentServerMessage[] = [];
  const observer = peer(messages);

  try {
    await host.resident.dispatch.dispatch({ request: 'already running' });
    await turnStarted.promise;
    await host.interaction.connect(observer);
    await host.interaction.handle(observer, {
      type: 'session.snapshot.get',
      requestId: 'late-snapshot',
    });

    const snapshot = messages.find((message) => (
      message.type === 'session.snapshot.result'
      && message.requestId === 'late-snapshot'
    ));
    assert.equal(snapshot?.type, 'session.snapshot.result');
    if (snapshot?.type !== 'session.snapshot.result') return;
    const requestId = snapshot.snapshot.session.activeRun?.requestId;
    assert.match(requestId ?? '', /^host-/);

    releaseTurn.resolve();
    await waitFor(
      () => messages.some((message) => (
        message.type === 'event'
        && message.event.type === 'message.completed'
      )),
      'late observer did not receive the remaining dispatch events',
    );

    let projected = snapshot.snapshot.session;
    for (const message of messages) {
      if (message.type !== 'event' || message.event.requestId !== requestId) continue;
      projected = reduceSession(projected, {
        type: 'runtime.event',
        event: message.event,
      }, { observedAt: Date.now() });
    }
    assert.equal(projected.activeRun, null);
    assert.ok(projected.timeline.some((entry) => (
      entry.type === 'message'
      && entry.role === 'assistant'
      && entry.status === 'completed'
      && entry.text === 'finishing work'
    )));
  } finally {
    releaseTurn.resolve();
    await host.close();
  }
});

test('resident policy updates reach conversation and dispatch without changing another Host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-host-config-'));
  const seen: Array<{ petId: string; mode: string | undefined; safetyLevel: unknown; workdir: unknown }> = [];
  const persisted: unknown[] = [];
  const makeHost = async (petId: string) => {
    const runtimeConfig = buildLocalAgentRuntimeConfig(join(root, petId));
    return createResidentPetHost({
      petId, petName: petId,
      modelProfiles: createTestModelProfiles(),
      runtimeConfig,
      globalReviewPolicyMode: 'full_access',
      autoAuthorizationSafetyLevel: 'relaxed',
      capabilityRegistryBackend: 'memory',
      capabilities: [],
      toolkitInventory: new HostToolkitInventoryStore(),
      capabilityArtifactStore: testArtifactStore,
      checkpointer: new FileSaver(runtimeConfig.checkpointPath),
      sessionStatePath: runtimeConfig.tuiSessionPath,
      persistGlobalReviewPolicyMode: (mode, safetyLevel) => { persisted.push({ mode, safetyLevel }); },
      graphService: {
        readThreadState: async () => ({ messages: [], pendingInterrupt: null, hasPendingContinuation: false, currentPlan: null }),
      } as never,
      runAgentTurn: async ({ setup }) => {
        seen.push({ petId, mode: setup.input.globalReviewPolicy?.mode,
          safetyLevel: setup.input.globalReviewPolicy && 'safetyLevel' in setup.input.globalReviewPolicy
            ? setup.input.globalReviewPolicy.safetyLevel : undefined,
          workdir: setup.input.context?.workdir });
        return { status: 'completed', reply: 'done' };
      },
    });
  };
  const hostA = await makeHost('a');
  const hostB = await makeHost('b');
  const connection = peer([]);
  try {
    await hostA.interaction.connect(connection);
    await hostA.interaction.handle(connection, {
      type: 'runtime_config.update', requestId: 'policy',
      globalReviewPolicyMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
    });
    await hostA.interaction.handle(connection, {
      type: 'chat_request', requestId: 'chat', message: 'from conversation',
    });
    hostA.resident.dispatch.dispatch({ request: 'from dispatch' });
    hostB.resident.dispatch.dispatch({ request: 'from other Host' });
    await waitFor(() => seen.length === 3, 'both dispatches must reach the shared run boundary');
    assert.deepEqual(persisted, [{ mode: 'require_authorization', safetyLevel: 'strict' }]);
    const a = seen.filter(entry => entry.petId === 'a');
    assert.equal(a.length, 2);
    for (const entry of a) {
      assert.deepEqual(entry, { petId: 'a', mode: 'require_authorization', safetyLevel: 'strict', workdir: join(root, 'a') });
    }
    assert.deepEqual(seen.find(entry => entry.petId === 'b'), {
      petId: 'b', mode: 'full_access', safetyLevel: 'relaxed', workdir: join(root, 'b'),
    });
  } finally {
    await hostA.close();
    await hostB.close();
  }
});
