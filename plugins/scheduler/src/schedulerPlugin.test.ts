import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStudio } from '@pinpawo/studio';
import { createSchedulerPlugin } from './schedulerPlugin';

test('Scheduler dispatches one due schedule exactly once', async (t) => {
  let requests = 0;
  const events: string[] = [];
  const plugin = createSchedulerPlugin({ pollIntervalMs: 10, httpRoute: false });
  const studio = await createStudio({
    studioId: 'scheduler-test',
    entryPetId: 'worker',
    pets: [{
      registration: { petId: 'worker', name: 'Worker', role: null, serviceSummary: null },
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
    listPets: () => [{ petId: 'worker', name: 'Worker', role: null, serviceSummary: null }],
    listDispatchQueues: () => [{
      petId: 'worker', state: 'blocked', activeOperation: null, queuedConversations: 0, queuedDispatches: 2,
    }],
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
