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
        getState: () => 'open',
        onStateChange: () => () => undefined,
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
