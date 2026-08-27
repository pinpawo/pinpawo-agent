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
