import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SchedulerService } from './schedulerService';

test('Scheduler recovers an unknown dispatch outcome as failed without re-claiming it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-scheduler-'));
  const databasePath = path.join(root, 'scheduler.sqlite');
  const first = new SchedulerService(databasePath);
  await first.init();
  const schedule = await first.create({
    petId: 'worker',
    request: 'one shot',
    runAt: new Date(Date.now() - 1000).toISOString(),
  });
  await first.claimDue();
  await first.close();

  const second = new SchedulerService(databasePath);
  await second.init();
  t.after(() => second.close());
  assert.equal((await second.get(schedule.scheduleId))?.status, 'failed');
  assert.equal(await second.claimDue(), null);
  assert.deepEqual(
    (await second.events()).map(({ eventType }) => eventType),
    ['created', 'claimed', 'recovered'],
  );
});
