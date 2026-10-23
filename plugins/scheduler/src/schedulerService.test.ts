import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStudioStorage, type StudioStorageConfig } from '@pinpawo/studio-core';
import { createPglitePool } from '../../../tests/support/pglitePool';
import { SchedulerService } from './schedulerService';
import { KyselyScheduleStore, schedulerMigrations, type SchedulerDatabase } from './store/kysely';

const backends: Array<[string, () => StudioStorageConfig]> = [
  ['sqlite', () => ({ kind: 'sqlite', path: ':memory:' })],
  ['postgres', () => ({ kind: 'postgres', pool: createPglitePool() })],
];
const past = () => new Date(Date.now() - 1000).toISOString();

for (const [backend, config] of backends) {
  async function withServices(run: (open: () => Promise<SchedulerService>) => Promise<void>) {
    const storage = createStudioStorage(config());
    try {
      // Each service is a Studio process sharing the one database.
      await run(async () => new SchedulerService(new KyselyScheduleStore(
        await storage.open<SchedulerDatabase>('scheduler', schedulerMigrations(storage.dialect)),
      )));
    } finally { await storage.close(); }
  }

  test(`${backend}: a schedule moves scheduled, dispatching, dispatched with one event per step and keeps its receipt`, () => withServices(async (open) => {
    const service = await open();
    const seen: string[] = [];
    service.subscribe(({ event }) => seen.push(event.eventType));
    const schedule = await service.create({ petId: ' worker ', channelId: 'ops', request: 'report', runAt: past() });
    assert.deepEqual([schedule.petId, schedule.channelId, schedule.status], ['worker', 'ops', 'scheduled']);
    await assert.rejects(service.create({ petId: 'worker', request: 'x', runAt: 'later' }), /ISO date/);
    await assert.rejects(service.markDispatched(schedule.scheduleId), /is scheduled/);
    assert.equal(await service.claimDue(new Date(Date.now() - 60_000)), null, 'not due yet');

    const claimed = await service.claimDue();
    assert.equal(claimed?.status, 'dispatching');
    assert.equal(await service.claimDue(), null);
    const done = await service.markDispatched(schedule.scheduleId, { invocationId: 'inv-1', sessionId: 's-1' });
    assert.deepEqual([done.status, done.receipt], ['dispatched', { invocationId: 'inv-1', sessionId: 's-1' }]);
    await assert.rejects(service.cancel(schedule.scheduleId), /is dispatched/);

    const later = await service.create({ petId: 'worker', request: 'later', runAt: new Date(Date.now() + 60_000).toISOString() });
    assert.equal((await service.cancel(later.scheduleId)).status, 'cancelled');

    assert.deepEqual(seen, ['created', 'claimed', 'dispatched', 'created', 'cancelled']);
    const events = await service.events();
    assert.deepEqual(events.map(event => event.eventType), seen);
    assert.deepEqual((await service.events(events[2]!.sequence, 1)).map(event => event.eventType), ['created']);
    const snapshot = await service.snapshot();
    assert.equal(snapshot.lastEventSequence, events.at(-1)!.sequence);
    assert.deepEqual(snapshot.schedules.map(item => item.status), ['dispatched', 'cancelled']);
    await assert.rejects(service.events(-1), /cursor/);
    await assert.rejects(service.events(0, 1001), /limit/);
  }));

  test(`${backend}: two Studios on one database claim a due schedule once`, () => withServices(async (open) => {
    const [a, b] = [await open(), await open()];
    for (let index = 0; index < 4; index++) await a.create({ petId: 'worker', request: `job ${index.toString()}`, runAt: past() });
    const claimed: string[] = [];
    await Promise.all([a, b].map(async (service) => {
      for (let next = await service.claimDue(); next; next = await service.claimDue()) claimed.push(next.scheduleId);
    }));
    assert.equal(claimed.length, 4);
    assert.equal(new Set(claimed).size, 4);
  }));

  test(`${backend}: a schedule left dispatching by a stopped Studio is recovered as failed, not run again`, () => withServices(async (open) => {
    const first = await open();
    const schedule = await first.create({ petId: 'worker', request: 'one shot', runAt: past() });
    await first.claimDue();

    const second = await open();
    const seen: string[] = [];
    second.subscribe(({ schedule: item, event }) => seen.push(`${event.eventType}:${item.status}`));
    await second.recoverInterrupted();
    const recovered = await second.get(schedule.scheduleId);
    assert.deepEqual([recovered?.status, recovered?.note], ['failed', 'dispatch outcome unknown after restart']);
    assert.equal(await second.claimDue(), null);
    assert.deepEqual(seen, ['recovered:failed']);
    assert.deepEqual((await second.events()).map(({ eventType }) => eventType), ['created', 'claimed', 'recovered']);
  }));
}
