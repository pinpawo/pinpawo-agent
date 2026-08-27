import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStudio } from '@pinpawo/studio';
import { createTriggerPlugin } from './triggerPlugin';

test('Trigger projects direct service mutations through Studio events', async (t) => {
  const plugin = createTriggerPlugin({
    httpRoute: false,
    triggers: [{
      triggerId: 'build',
      petId: 'worker',
      requestPrefix: 'Handle build',
      secret: 'trigger-secret-with-at-least-16-characters',
    }],
  });
  const studio = await createStudio({
    studioId: 'trigger-test',
    entryPetId: 'worker',
    pets: [{
      registration: { petId: 'worker', name: 'Worker' },
      dispatch: {
        getState: () => 'open',
        onStateChange: () => () => undefined,
        dispatch: async () => undefined,
      },
    }],
    plugins: [plugin],
  });
  t.after(() => studio.shutdown());
  const events: string[] = [];
  studio.subscribe((event) => { events.push(event.type); });

  const claimed = await plugin.service.claim('build', 'delivery-1');
  await plugin.service.accept(claimed.delivery.deliveryId);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, ['trigger.received', 'trigger.accepted']);
});
