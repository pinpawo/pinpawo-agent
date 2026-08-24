import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createStudio } from './createStudio';
import type { StudioPlugin, StudioPluginContext } from './studioContract';
import type {
  PetAgentRuntime,
  PetAgentRuntimeInvokeInput,
  PetAgentRuntimeInvokeResult,
} from './types';

const pendingContinuation = {
  continuationId: 'continuation-1',
  payload: {
    kind: 'human_review' as const,
    interactions: [{
      interactionId: 'review-1',
      schemaVersion: 2 as const,
      view: { kind: 'plain' as const, body: 'Approve?' },
      options: [{
        id: 'approve',
        label: 'Approve',
        batchSubmission: 'defer' as const,
      }],
    }],
  },
};

function pet(options: {
  petId: string;
  disabled?: boolean;
  invoke?: (
    input: PetAgentRuntimeInvokeInput,
  ) => PetAgentRuntimeInvokeResult | Promise<PetAgentRuntimeInvokeResult>;
}): PetAgentRuntime {
  return {
    descriptor: () => ({
      petId: options.petId,
      userId: null,
      name: options.petId,
      personality: null,
      stage: null,
      species: null,
      role: null,
      serviceSummary: null,
      startupMode: options.disabled ? 'disabled' : 'standby',
      status: options.disabled ? 'disabled' : 'standby',
      capabilities: [],
    }),
    invoke: async (input) => options.invoke
      ? options.invoke(input)
      : { status: 'completed', reply: 'done' },
    gate: () => 'open',
    onGateChange: () => () => undefined,
  };
}

const request = (petId: string, text: string) => ({
  petId,
  input: { kind: 'request' as const, request: text },
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('dispatch acknowledges immediately and exposes terminal completion separately', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [pet({
      petId: 'worker',
      invoke: async () => {
        await held;
        return { status: 'completed', reply: 'eventually' };
      },
    })],
  });

  const receipt = await studio.dispatch(request('worker', 'do it'));
  const race = await Promise.race([
    receipt.completion.then(() => 'completed'),
    flush().then(() => 'still-running'),
  ]);
  assert.equal(race, 'still-running');
  release();
  const result = await receipt.completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'eventually');
});

test('a receipt replays current progress and observes only its invocation', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [pet({
      petId: 'worker',
      invoke: async () => {
        await held;
        return { status: 'completed', reply: 'done' };
      },
    })],
  });

  const receipt = await studio.dispatch(request('worker', 'observe me'));
  const statuses: string[] = [];
  const unsubscribe = receipt.onInvocation((event) => {
    assert.equal(event.invocationId, receipt.invocationId);
    statuses.push(event.status);
  });
  await flush();
  assert.deepEqual(statuses, ['busy']);

  release();
  await receipt.completion;
  await flush();
  assert.deepEqual(statuses, ['busy', 'completed']);
  unsubscribe();
});

test('repeated dispatches reuse one Pet thread and receive distinct invocation ids', async () => {
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [pet({ petId: 'worker' })],
  });

  const first = await studio.dispatch(request('worker', 'first'));
  const second = await studio.dispatch(request('worker', 'second'));
  assert.equal(first.threadId, 'studio:s1:pet:worker');
  assert.equal(second.threadId, first.threadId);
  assert.notEqual(second.invocationId, first.invocationId);
  await Promise.all([first.completion, second.completion]);
});

test('different Pets own different stable threads', async () => {
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'a',
    pets: [pet({ petId: 'a' }), pet({ petId: 'b' })],
  });
  const a = await studio.dispatch(request('a', 'a'));
  const b = await studio.dispatch(request('b', 'b'));
  assert.notEqual(a.threadId, b.threadId);
  await Promise.all([a.completion, b.completion]);
});

test('the Studio registry exposes a read-only Pet registration rather than actor internals', async () => {
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [pet({ petId: 'worker' })],
  });

  assert.deepEqual(studio.listPets(), [{
    petId: 'worker',
    name: 'worker',
    role: null,
    serviceSummary: null,
    startupMode: 'standby',
    status: 'standby',
    capabilities: [],
  }]);
});

test('concurrent dispatches never invoke one Pet concurrently', async () => {
  const started: string[] = [];
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [pet({
      petId: 'worker',
      invoke: async (input) => {
        const text = input.input.kind === 'request' ? input.input.request : 'resume';
        started.push(text);
        if (text === 'first') await firstHeld;
        return { status: 'completed', reply: text };
      },
    })],
  });

  const first = await studio.dispatch(request('worker', 'first'));
  const second = await studio.dispatch(request('worker', 'second'));
  await flush();
  assert.deepEqual(started, ['first']);
  releaseFirst();
  await Promise.all([first.completion, second.completion]);
  assert.deepEqual(started, ['first', 'second']);
});

test('a dispatch cancelled while queued never invokes its Pet', async () => {
  const started: string[] = [];
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [pet({
      petId: 'worker',
      invoke: async (input) => {
        const text = input.input.kind === 'request' ? input.input.request : 'resume';
        started.push(text);
        if (text === 'first') await firstHeld;
        return { status: 'completed', reply: text };
      },
    })],
  });
  const cancellation = new AbortController();

  const first = await studio.dispatch(request('worker', 'first'));
  const second = await studio.dispatch({
    ...request('worker', 'second'),
    signal: cancellation.signal,
  });
  cancellation.abort();
  releaseFirst();

  assert.equal((await first.completion).status, 'completed');
  assert.equal((await second.completion).status, 'cancelled');
  assert.deepEqual(started, ['first']);
});

test('a durable continuation settles its invocation and admits a later resume', async () => {
  const inputs: PetAgentRuntimeInvokeInput[] = [];
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [pet({
      petId: 'worker',
      invoke: async (input) => {
        inputs.push(input);
        return input.input.kind === 'request'
          ? { status: 'waiting', pendingContinuation }
          : { status: 'completed', reply: 'resumed' };
      },
    })],
  });

  const initial = await studio.dispatch(request('worker', 'needs review'));
  const waiting = await initial.completion;
  assert.equal(waiting.status, 'waiting');
  const resumed = await studio.dispatch({
    petId: 'worker',
    input: {
      kind: 'resume',
      continuationId: 'continuation-1',
      payload: {
        kind: 'human_review_response',
        responses: [{ interactionId: 'review-1', selectedOptionId: 'approve' }],
      },
    },
  });
  const completed = await resumed.completion;
  assert.equal(completed.status, 'completed');
  assert.equal(resumed.threadId, initial.threadId);
  assert.notEqual(resumed.invocationId, initial.invocationId);
  assert.deepEqual(inputs.map((item) => item.input.kind), ['request', 'resume']);
});

test('a restarted Studio resolves the same Pet thread and can resume its pending work', async () => {
  let waiting = false;
  const invokedThreads: string[] = [];
  const createResidentPet = () => pet({
    petId: 'worker',
    invoke: async (input) => {
      invokedThreads.push(input.threadId);
      if (input.input.kind === 'request') {
        waiting = true;
        return { status: 'waiting', pendingContinuation };
      }
      assert.equal(waiting, true);
      assert.equal(input.input.continuationId, 'continuation-1');
      waiting = false;
      return { status: 'completed', reply: 'resumed after restart' };
    },
  });
  const firstStudio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [createResidentPet()],
  });
  const first = await firstStudio.dispatch(request('worker', 'start'));
  assert.equal((await first.completion).status, 'waiting');
  await firstStudio.shutdown();

  const restartedStudio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [createResidentPet()],
  });
  const resumed = await restartedStudio.dispatch({
    petId: 'worker',
    input: {
      kind: 'resume',
      continuationId: 'continuation-1',
      payload: {
        kind: 'human_review_response',
        responses: [{ interactionId: 'review-1', selectedOptionId: 'approve' }],
      },
    },
  });
  assert.equal((await resumed.completion).status, 'completed');
  assert.equal(resumed.threadId, first.threadId);
  assert.deepEqual(invokedThreads, ['studio:s1:pet:worker', 'studio:s1:pet:worker']);
});

test('idempotency returns the existing invocation receipt', async () => {
  let calls = 0;
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [pet({ petId: 'worker', invoke: async () => {
      calls += 1;
      return { status: 'completed', reply: 'done' };
    } })],
  });
  const first = await studio.dispatch({ ...request('worker', 'go'), idempotencyKey: 'job-1' });
  const retry = await studio.dispatch({ ...request('worker', 'go'), idempotencyKey: 'job-1' });
  assert.equal(retry, first);
  await retry.completion;
  assert.equal(calls, 1);
});

test('failed Pet work settles as failed without rejecting acceptance', async () => {
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [pet({ petId: 'worker', invoke: async () => { throw new Error('pet exploded'); } })],
  });
  const receipt = await studio.dispatch(request('worker', 'go'));
  assert.deepEqual(
    { status: (await receipt.completion).status, error: (await receipt.completion).error },
    { status: 'failed', error: 'pet exploded' },
  );
});

test('a Plugin observes only invocations it dispatched', async () => {
  const seen: string[] = [];
  let mine!: StudioPluginContext;
  let theirs!: StudioPluginContext;
  const plugin = (name: string, capture?: (context: StudioPluginContext) => void): StudioPlugin => ({
    name,
    toolkits: [],
    start: (context) => capture?.(context),
  });
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [pet({ petId: 'worker' })],
    plugins: [
      plugin('mine', (context) => {
        mine = context;
        context.onInvocation((event) => { seen.push(event.invocationId); });
      }),
      plugin('theirs', (context) => { theirs = context; }),
    ],
  });
  const own = await mine.dispatch(request('worker', 'mine'));
  const other = await theirs.dispatch(request('worker', 'theirs'));
  await Promise.all([own.completion, other.completion]);
  assert.ok(seen.length >= 2);
  assert.ok(seen.every((id) => id === own.invocationId));
});

test('Host invocation events carry identity, metadata, and pending projection', async () => {
  const events: Array<{ status: string; invocationId: string; taskId?: unknown }> = [];
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [pet({
      petId: 'worker',
      invoke: async () => ({ status: 'waiting', pendingContinuation }),
    })],
  });
  studio.onInvocation((event) => {
    events.push({
      status: event.status,
      invocationId: event.invocationId,
      taskId: event.metadata?.taskId,
    });
  });
  const receipt = await studio.dispatch({
    ...request('worker', 'go'),
    metadata: { taskId: 'task-1' },
  });
  await receipt.completion;
  await flush();
  assert.deepEqual(events.map(({ status }) => status), ['busy', 'waiting']);
  assert.ok(events.every(({ invocationId }) => invocationId === receipt.invocationId));
  assert.ok(events.every(({ taskId }) => taskId === 'task-1'));
});

test('Plugin events remain an opaque broadcast channel', async () => {
  const received: unknown[] = [];
  let publish!: StudioPluginContext['notify'];
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [pet({ petId: 'worker' })],
    plugins: [{
      name: 'source',
      toolkits: [],
      start: (context) => { publish = context.notify; },
    }],
  });
  studio.subscribe((event) => { received.push(event); });
  publish({ type: 'task.done', metadata: { taskId: 'task-1' }, payload: { ok: true } });
  await flush();
  assert.equal(received.length, 1);
  assert.deepEqual((received[0] as { metadata: unknown }).metadata, { taskId: 'task-1' });
});

test('Plugin hooks attach in either start order and detach with contributor lifecycle', async () => {
  for (const consumerFirst of [true, false]) {
    const installed: string[] = [];
    const removed: string[] = [];
    const provider: StudioPlugin = {
      name: 'provider',
      toolkits: [],
      start: (context) => {
        context.hooks.expose('routes', {
          register: (path: string) => {
            installed.push(path);
            return () => { removed.push(path); };
          },
        });
      },
    };
    const consumer: StudioPlugin = {
      name: 'consumer',
      toolkits: [],
      start: (context) => {
        context.hooks.contribute<{ register: (path: string) => () => void }>(
          'provider',
          'routes',
          (routes) => routes.register('/consumer'),
        );
      },
    };
    const studio = await createStudio({
      studioId: `hooks-${consumerFirst ? 'consumer-first' : 'provider-first'}`,
      entryPetId: 'worker',
      pets: [pet({ petId: 'worker' })],
      plugins: consumerFirst ? [consumer, provider] : [provider, consumer],
    });

    assert.deepEqual(installed, ['/consumer']);
    await studio.shutdown();
    assert.deepEqual(removed, ['/consumer']);
  }
});

test('plugins start in order, stop in reverse, and startup failure rolls back', async () => {
  const order: string[] = [];
  const plugin = (name: string, fail = false): StudioPlugin => ({
    name,
    toolkits: [],
    start: () => {
      order.push(`start:${name}`);
      if (fail) throw new Error('cannot start');
    },
    stop: () => { order.push(`stop:${name}`); },
  });
  await assert.rejects(
    () => createStudio({
      studioId: 's1',
      entryPetId: 'worker',
      pets: [pet({ petId: 'worker' })],
      plugins: [plugin('a'), plugin('b', true)],
    }),
    /cannot start/,
  );
  assert.deepEqual(order, ['start:a', 'start:b', 'stop:b', 'stop:a']);
});

test('dispatch rejects unknown, disabled, and stopped targets', async () => {
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [pet({ petId: 'worker' }), pet({ petId: 'off', disabled: true })],
  });
  await assert.rejects(() => studio.dispatch(request('ghost', 'go')), /unknown petId/);
  await assert.rejects(() => studio.dispatch(request('off', 'go')), /is disabled/);
  await studio.shutdown();
  await assert.rejects(() => studio.dispatch(request('worker', 'go')), /already shut down/);
});
