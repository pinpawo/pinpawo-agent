import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStudioStorage, type StudioStorageConfig } from '@pinpawo/studio';
import { createPglitePool } from '../../../tests/support/pglitePool';
import { TriggerService } from './triggerService';
import { KyselyTriggerStore, triggerMigrations, type TriggerDatabase } from './store/kysely';

const backends: Array<[string, () => StudioStorageConfig]> = [
  ['sqlite', () => ({ kind: 'sqlite', path: ':memory:' })],
  ['postgres', () => ({ kind: 'postgres', pool: createPglitePool() })],
];

for (const [backend, config] of backends) {
  async function withServices(run: (open: () => Promise<TriggerService>) => Promise<void>) {
    const storage = createStudioStorage(config());
    try {
      // Each service is a Studio process sharing the one database.
      await run(async () => new TriggerService(new KyselyTriggerStore(
        await storage.open<TriggerDatabase>('trigger', triggerMigrations(storage.dialect)),
      )));
    } finally { await storage.close(); }
  }

  test(`${backend}: delivery idempotency returns the first durable delivery`, () => withServices(async (open) => {
    const service = await open();
    const seen: string[] = [];
    service.subscribe(({ event }) => seen.push(event.eventType));
    const first = await service.claim('build', 'delivery-1');
    const duplicate = await service.claim('build', 'delivery-1');
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.delivery.deliveryId, first.delivery.deliveryId);
    assert.equal((await service.claim('deploy', 'delivery-1')).duplicate, false, 'keys are per trigger');

    const accepted = await service.accept(first.delivery.deliveryId, { invocationId: 'inv-1', sessionId: 's-1' });
    assert.deepEqual([accepted.status, accepted.receipt], ['accepted', { invocationId: 'inv-1', sessionId: 's-1' }]);
    await assert.rejects(service.fail(first.delivery.deliveryId, 'late'), /is not dispatching/);
    assert.deepEqual(seen, ['received', 'received', 'accepted']);
    const events = await service.events();
    assert.deepEqual(events.map(({ eventType }) => eventType), seen);
    assert.equal((await service.snapshot()).lastEventSequence, events.at(-1)!.sequence);
  }));

  test(`${backend}: two Studios claiming the same key record one delivery`, () => withServices(async (open) => {
    const [one, two] = [await open(), await open()];
    const claims = await Promise.all([one.claim('build', 'delivery-1'), two.claim('build', 'delivery-1')]);
    assert.deepEqual(claims.map(({ duplicate }) => duplicate).sort(), [false, true]);
    assert.equal(claims[0].delivery.deliveryId, claims[1].delivery.deliveryId);
    assert.deepEqual((await one.events()).map(({ eventType }) => eventType), ['received']);
  }));

  test(`${backend}: a failed delivery is retried with its retained input and the note cleared`, () => withServices(async (open) => {
    const service = await open();
    const bare = await service.claim('build', 'bare');
    await service.fail(bare.delivery.deliveryId, 'no pet');
    await assert.rejects(service.retry(bare.delivery.deliveryId), /no retained dispatch input/);

    const claimed = await service.claim('build', 'delivery-1', { targetPetId: ' worker ', request: 'Build.' });
    assert.deepEqual([claimed.delivery.targetPetId, claimed.delivery.request], ['worker', 'Build.']);
    await assert.rejects(service.retry(claimed.delivery.deliveryId), /not retryable/);
    const failed = await service.fail(claimed.delivery.deliveryId, 'offline');
    assert.deepEqual([failed.status, failed.note], ['failed', 'offline']);
    const retried = await service.retry(claimed.delivery.deliveryId);
    assert.deepEqual([retried.status, retried.note], ['dispatching', undefined]);
  }));

  test(`${backend}: an accepted delivery can be explicitly redelivered without rewriting its receipt`, () => withServices(async (open) => {
    const service = await open();
    const original = await service.claim('build', 'delivery-1', { targetPetId: 'worker', request: 'Build the release.' });
    await service.accept(original.delivery.deliveryId, { invocationId: 'inv-1' });

    const redelivery = await service.redeliver(original.delivery.deliveryId);
    assert.notEqual(redelivery.deliveryId, original.delivery.deliveryId);
    assert.equal(redelivery.status, 'dispatching');
    assert.equal(redelivery.targetPetId, 'worker');
    assert.equal(redelivery.request, 'Build the release.');
    assert.match(redelivery.note ?? '', new RegExp(original.delivery.deliveryId));
    const kept = await service.getDelivery(original.delivery.deliveryId);
    assert.deepEqual([kept?.status, kept?.receipt], ['accepted', { invocationId: 'inv-1' }]);
    assert.deepEqual(await service.getDelivery(redelivery.deliveryId), redelivery);
    assert.deepEqual(
      (await service.events()).map(({ eventType }) => eventType),
      ['received', 'accepted', 'redelivered'],
    );
  }));

  test(`${backend}: a restart fails interrupted deliveries and keeps deduplication`, () => withServices(async (open) => {
    const first = await open();
    const claimed = await first.claim('build', 'delivery-1');

    const second = await open();
    const recovered: string[] = [];
    second.subscribe(({ delivery, event }) => recovered.push(`${event.eventType}:${delivery.status}`));
    await second.recoverInterrupted();
    assert.deepEqual(recovered, ['recovered:failed']);
    const duplicate = await second.claim('build', 'delivery-1');
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.delivery.deliveryId, claimed.delivery.deliveryId);
    assert.deepEqual([duplicate.delivery.status, duplicate.delivery.note], ['failed', 'dispatch outcome unknown after restart']);
    assert.deepEqual((await second.events()).map(({ eventType }) => eventType), ['received', 'recovered']);
  }));
}
