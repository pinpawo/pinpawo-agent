import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createStudio, createStudioStorage, StudioClients, type StudioDispatchRequest } from '@pinpawo/studio';
import {
  ChannelService, KyselyChannelStore, channelMigrations, createChannelPlugin, type ChannelDatabase,
} from '@pinpawo-plugin/channel';
import { createSchedulerPlugin } from './schedulerPlugin';
import { SchedulerService } from './schedulerService';
import { KyselyScheduleStore, schedulerMigrations, type SchedulerDatabase } from './store/kysely';

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
  const storage = createStudioStorage({ kind: 'sqlite', path: ':memory:' });
  t.after(() => storage.close());
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
    storage: { dialect: 'sqlite', open: (migrations) => storage.open('scheduler', migrations) },
    clients: new StudioClients(async () => { throw new Error('not used'); }),
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

test('a channel-bound schedule runs its Pet in the Channel without posting there, and keeps the receipt', async (t) => {
  const dispatched: StudioDispatchRequest[] = [];
  const channel = createChannelPlugin({ httpRoute: false });
  const scheduler = createSchedulerPlugin({ pollIntervalMs: 10, httpRoute: false });
  const studio = await createStudio({
    studioId: 'scheduler-channel',
    entryPetId: 'reporter',
    pets: [recordingPet('reporter', dispatched)],
    plugins: [scheduler, channel],
  });
  t.after(() => studio.shutdown());
  const { channel: { channelId } } = await channel.service.createChannel({ kind: 'human', id: 'local' }, { title: 'Ops', pets: ['reporter'] });

  const schedule = await scheduler.service.create({
    petId: 'reporter', channelId, request: 'Write the nightly report',
    runAt: new Date(Date.now() - 1000).toISOString(),
  });
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0]?.scope, { namespace: 'channel', id: channelId });
  assert.ok(dispatched[0]?.session?.id);
  assert.match(dispatched[0]!.request, /"type": "channel_task"/);
  assert.match(dispatched[0]!.request, new RegExp(`"origin": \\{\\s*"kind": "scheduler",\\s*"id": "${schedule.scheduleId}"`));
  assert.deepEqual((await channel.service.readContext({ kind: 'human', id: 'local' }, channelId)).messages, []);
  const stored = await scheduler.service.get(schedule.scheduleId);
  assert.equal(stored?.status, 'dispatched');
  assert.equal(stored?.receipt?.sessionId, dispatched[0]?.session?.id);
  assert.ok(stored?.receipt?.invocationId);
});

test('a channel-bound schedule fails when its Pet is not a member of the Channel', async (t) => {
  const dispatched: StudioDispatchRequest[] = [];
  const channel = createChannelPlugin({ httpRoute: false });
  const scheduler = createSchedulerPlugin({ pollIntervalMs: 10, httpRoute: false });
  const studio = await createStudio({
    studioId: 'scheduler-channel-member',
    entryPetId: 'reporter',
    pets: [recordingPet('reporter', dispatched)],
    plugins: [scheduler, channel],
  });
  t.after(() => studio.shutdown());
  const { channel: { channelId } } = await channel.service.createChannel({ kind: 'human', id: 'local' }, { title: 'Ops', pets: [] });

  const schedule = await scheduler.service.create({
    petId: 'reporter', channelId, request: 'Write the nightly report',
    runAt: new Date(Date.now() - 1000).toISOString(),
  });
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(dispatched.length, 0);
  const stored = await scheduler.service.get(schedule.scheduleId);
  assert.equal(stored?.status, 'failed');
  assert.match(stored?.note ?? '', /not a member/);
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

for (const order of ['scheduler first', 'channel first'] as const) {
  test(`a channel-bound schedule that fell due while stopped is delivered on restart (${order})`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-scheduler-restart-'));
    const databasePath = path.join(root, 'studio.sqlite');
    const storage = createStudioStorage({ kind: 'sqlite', path: databasePath });
    const store = new KyselyChannelStore(await storage.open<ChannelDatabase>('channel', channelMigrations(storage.dialect)));
    const { channel: { channelId } } = await new ChannelService({ store, pets: () => [{ petId: 'reporter', name: 'reporter' }], humans: async () => undefined })
      .createChannel({ kind: 'human', id: 'local' }, { title: 'Ops', pets: ['reporter'] });
    // Stored before the restart and already due when the Studio comes back.
    const offline = new SchedulerService(new KyselyScheduleStore(
      await storage.open<SchedulerDatabase>('scheduler', schedulerMigrations(storage.dialect)),
    ));
    const schedule = await offline.create({
      petId: 'reporter', channelId, request: 'Write the nightly report',
      runAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await storage.close();
    const channel = createChannelPlugin({ httpRoute: false });

    const dispatched: StudioDispatchRequest[] = [];
    const scheduler = createSchedulerPlugin({ pollIntervalMs: 10, httpRoute: false });
    const studio = await createStudio({
      studioId: 'scheduler-restart',
      entryPetId: 'reporter',
      pets: [recordingPet('reporter', dispatched)],
      plugins: order === 'scheduler first' ? [scheduler, channel] : [channel, scheduler],
      storage: { kind: 'sqlite', path: databasePath },
    });
    t.after(() => studio.shutdown());
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0]?.scope, { namespace: 'channel', id: channelId });
    assert.equal((await scheduler.service.get(schedule.scheduleId))?.status, 'dispatched');
  });
}
