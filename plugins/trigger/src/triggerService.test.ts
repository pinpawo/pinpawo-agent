import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TriggerService } from './triggerService';

test('Trigger delivery idempotency returns the first durable delivery', async (t) => {
  const service = new TriggerService();
  await service.init();
  t.after(() => service.close());

  const first = await service.claim('build', 'delivery-1');
  const duplicate = await service.claim('build', 'delivery-1');
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.delivery.deliveryId, first.delivery.deliveryId);

  await service.accept(first.delivery.deliveryId);
  assert.deepEqual(
    (await service.events()).map(({ eventType }) => eventType),
    ['received', 'accepted'],
  );
});

test('Trigger recovers an unknown dispatch outcome and preserves deduplication', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-trigger-'));
  const databasePath = path.join(root, 'trigger.sqlite');
  const first = new TriggerService(databasePath);
  await first.init();
  const claimed = await first.claim('build', 'delivery-1');
  await first.close();

  const second = new TriggerService(databasePath);
  await second.init();
  t.after(() => second.close());
  const duplicate = await second.claim('build', 'delivery-1');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.delivery.deliveryId, claimed.delivery.deliveryId);
  assert.equal(duplicate.delivery.status, 'failed');
  assert.deepEqual(
    (await second.events()).map(({ eventType }) => eventType),
    ['received', 'recovered'],
  );
});

test('an accepted delivery can be explicitly redelivered without rewriting its receipt', async (t) => {
  const service = new TriggerService();
  await service.init();
  t.after(() => service.close());

  const original = await service.claim('build', 'delivery-1', {
    targetPetId: 'worker',
    request: 'Build the release.',
  });
  await service.accept(original.delivery.deliveryId);

  const redelivery = await service.redeliver(original.delivery.deliveryId);
  assert.notEqual(redelivery.deliveryId, original.delivery.deliveryId);
  assert.equal(redelivery.status, 'dispatching');
  assert.equal(redelivery.targetPetId, 'worker');
  assert.equal(redelivery.request, 'Build the release.');
  assert.match(redelivery.note ?? '', new RegExp(original.delivery.deliveryId));
  assert.equal((await service.getDelivery(original.delivery.deliveryId))?.status, 'accepted');
  assert.deepEqual(
    (await service.events()).map(({ eventType }) => eventType),
    ['received', 'accepted', 'redelivered'],
  );
});
