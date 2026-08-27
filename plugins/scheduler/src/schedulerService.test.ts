import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

test('Scheduler migrates the unreleased completed admission status to dispatched', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-scheduler-v0-'));
  const databasePath = path.join(root, 'scheduler.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE schedules (
      schedule_id TEXT PRIMARY KEY, pet_id TEXT NOT NULL, request TEXT NOT NULL,
      run_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('scheduled','dispatching','completed','failed','cancelled')),
      note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE schedule_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id TEXT NOT NULL,
      event_type TEXT NOT NULL, status TEXT NOT NULL, note TEXT, occurred_at TEXT NOT NULL,
      FOREIGN KEY (schedule_id) REFERENCES schedules(schedule_id) ON DELETE RESTRICT
    );
    INSERT INTO schedules VALUES (
      'schedule-1', 'worker', 'run once', '2026-01-01T00:00:00.000Z',
      'completed', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO schedule_events(
      schedule_id, event_type, status, note, occurred_at
    ) VALUES (
      'schedule-1', 'completed', 'completed', NULL, '2026-01-01T00:00:00.000Z'
    );
  `);
  database.close();

  const service = new SchedulerService(databasePath);
  await service.init();
  t.after(() => service.close());

  assert.equal((await service.get('schedule-1'))?.status, 'dispatched');
  assert.deepEqual(
    (await service.events()).map(({ eventType, status }) => [eventType, status]),
    [['dispatched', 'dispatched']],
  );
});
