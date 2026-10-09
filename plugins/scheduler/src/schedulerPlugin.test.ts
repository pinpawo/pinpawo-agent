import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStudio, type StudioDispatchRequest } from '@pinpawo/studio';
import { createChannelPlugin } from '@pinpawo-plugin/channel';
import { createSchedulerPlugin } from './schedulerPlugin';

function recordingPet(petId: string, dispatched: StudioDispatchRequest[]) {
  return {
    registration: { petId, name: petId },
    dispatch: {
      getQueueSnapshot: () => ({
        state: 'open' as const, activeOperation: null, queuedConversations: 0, queuedDispatches: 0,
      }),
      onQueueChange: () => () => undefined,
      onDispatchLifecycle: () => () => undefined,
      dispatch: async (input: StudioDispatchRequest) => { dispatched.push(input); },
    },
  };
}

test('Scheduler dispatches one due schedule exactly once', async (t) => {
  let requests = 0;
  const events: string[] = [];
  const plugin = createSchedulerPlugin({ pollIntervalMs: 10, httpRoute: false });
  const studio = await createStudio({
    studioId: 'scheduler-test',
    entryPetId: 'worker',
    pets: [{
      registration: { petId: 'worker', name: 'Worker' },
      dispatch: {
        getQueueSnapshot: () => ({
          state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0,
        }),
        onQueueChange: () => () => undefined,
        onDispatchLifecycle: () => () => undefined,
        dispatch: async () => { requests += 1; },
      },
    }],
    plugins: [plugin],
  });
  t.after(() => studio.shutdown());
  studio.subscribe((event) => { events.push(event.type); });

  const schedule = await plugin.service.create({
    petId: 'worker',
    request: 'run once',
    runAt: new Date(Date.now() - 1000).toISOString(),
  });
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(requests, 1);
  assert.equal((await plugin.service.get(schedule.scheduleId))?.status, 'dispatched');
  assert.deepEqual(events, [
    'schedule.created',
    'schedule.claimed',
    'dispatch.accepted',
    'schedule.fired',
  ]);
});

test('Scheduler audits configured dispatch queues without changing their admission state', async (t) => {
  const events: Array<{ type: string; payload?: unknown }> = [];
  const plugin = createSchedulerPlugin({
    pollIntervalMs: 10,
    dispatchQueueAudit: { intervalMs: 1_000 },
    httpRoute: false,
  });
  await plugin.start({
    dispatch: async () => ({ petId: 'worker', invocationId: 'unused' }),
    notify: (event) => { events.push(event); },
    subscribe: () => () => undefined,
    listPets: () => [{ petId: 'worker', name: 'Worker' }],
    listDispatchQueues: () => [{
      petId: 'worker', state: 'blocked', activeOperation: null, queuedConversations: 0, queuedDispatches: 2,
    }],
    petSessions: {
      snapshot: async () => { throw new Error('not used'); },
      observe: async () => { throw new Error('not used'); },
      review: async () => { throw new Error('not used'); },
    },
    hooks: {
      expose: () => () => undefined,
      contribute: () => () => undefined,
    },
  });
  t.after(() => plugin.stop?.());

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'dispatch.queues_attention_required');
  const payload = events[0]?.payload as {
    queues?: unknown;
    attentionStates?: unknown;
    checkedAt?: string;
  } | undefined;
  assert.deepEqual(payload?.queues, [{
    petId: 'worker', state: 'blocked', activeOperation: null, queuedConversations: 0, queuedDispatches: 2,
  }]);
  assert.deepEqual(payload?.attentionStates, ['waiting', 'blocked']);
  const checkedAt = payload?.checkedAt;
  assert.ok(typeof checkedAt === 'string' && Number.isFinite(Date.parse(checkedAt)));
});

test('a channel-bound schedule posts into its Channel and the Pet runs there', async (t) => {
  const dispatched: StudioDispatchRequest[] = [];
  const channel = createChannelPlugin({ databasePath: ':memory:', httpRoute: false });
  channel.service.init();
  const { channelId } = channel.service.createChannel(
    { title: 'Ops', goal: 'Keep the nightly reports', scope: 'Reports only' },
    { kind: 'human', id: 'studio-operator' },
  );
  const scheduler = createSchedulerPlugin({ pollIntervalMs: 10, httpRoute: false });
  const studio = await createStudio({
    studioId: 'scheduler-channel',
    entryPetId: 'reporter',
    pets: [recordingPet('reporter', dispatched)],
    plugins: [scheduler, channel],
  });
  t.after(() => studio.shutdown());

  const schedule = await scheduler.service.create({
    petId: 'reporter', channelId, request: 'Write the nightly report',
    runAt: new Date(Date.now() - 1000).toISOString(),
  });
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0]?.scope, { namespace: 'channel', id: channelId });
  assert.ok(dispatched[0]?.session?.id);
  assert.match(dispatched[0]!.request, /"participantId": "bot:scheduler"/);
  const messages = channel.service.readHistory(channelId).entries.filter((entry) => entry.kind === 'message');
  assert.deepEqual(messages.map((message) => message.author), [{ kind: 'bot', id: 'scheduler' }]);
  assert.equal((await scheduler.service.get(schedule.scheduleId))?.status, 'dispatched');
});

test('a channel-bound schedule fails when no Channel Plugin runs', async (t) => {
  const dispatched: StudioDispatchRequest[] = [];
  const scheduler = createSchedulerPlugin({ pollIntervalMs: 10, httpRoute: false });
  const studio = await createStudio({
    studioId: 'scheduler-no-channel',
    entryPetId: 'reporter',
    pets: [recordingPet('reporter', dispatched)],
    plugins: [scheduler],
  });
  t.after(() => studio.shutdown());

  const schedule = await scheduler.service.create({
    petId: 'reporter', channelId: 'ops', request: 'Write the nightly report',
    runAt: new Date(Date.now() - 1000).toISOString(),
  });
  await new Promise((resolve) => setTimeout(resolve, 60));

  // Never a silent fallback to a bare dispatch into whatever session is active.
  assert.equal(dispatched.length, 0);
  const stored = await scheduler.service.get(schedule.scheduleId);
  assert.equal(stored?.status, 'failed');
  assert.match(stored?.note ?? '', /Channel Plugin/);
});
