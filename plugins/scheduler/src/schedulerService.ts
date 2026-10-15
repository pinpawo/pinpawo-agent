import { randomUUID } from 'node:crypto';
import type { Schedule, ScheduleEvent, ScheduleReceipt, ScheduleStatus, ScheduleStore } from './store/scheduleStore';

export type { Schedule, ScheduleEvent, ScheduleReceipt, ScheduleStatus } from './store/scheduleStore';

export type ScheduleMutation = {
  schedule: Schedule;
  event: ScheduleEvent;
};

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Scheduler ${label} must not be empty.`);
  return normalized;
}

function parseDate(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`Scheduler ${label} must be an ISO date.`);
  return new Date(timestamp).toISOString();
}

/**
 * Schedule rules over a ScheduleStore: allowed transitions, claiming due
 * schedules, and recovery of runs interrupted by a restart. Notifications are
 * best effort after commit.
 */
export class SchedulerService {
  private readonly listeners = new Set<(mutation: ScheduleMutation) => void>();

  constructor(readonly store: ScheduleStore) {}

  subscribe(listener: (mutation: ScheduleMutation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async create(input: { petId: string; channelId?: string; request: string; runAt: string }): Promise<Schedule> {
    const now = new Date().toISOString();
    const schedule: Schedule = {
      scheduleId: randomUUID(),
      petId: nonEmpty(input.petId, 'petId'),
      ...(input.channelId === undefined ? {} : { channelId: nonEmpty(input.channelId, 'channelId') }),
      request: nonEmpty(input.request, 'request'),
      runAt: parseDate(input.runAt, 'runAt'),
      status: 'scheduled',
      createdAt: now,
      updatedAt: now,
    };
    const event = await this.store.transaction(async (store) => {
      await store.insertSchedule(schedule);
      return store.appendEvent({ scheduleId: schedule.scheduleId, eventType: 'created', status: 'scheduled', occurredAt: now });
    });
    this.publish({ schedule, event });
    return schedule;
  }

  async cancel(scheduleId: string): Promise<Schedule> {
    return this.transition(scheduleId, ['scheduled'], 'cancelled', 'cancelled');
  }

  /**
   * Claim the earliest due schedule. Another Studio on the same database may
   * claim it first; then the next one is tried.
   */
  async claimDue(now = new Date()): Promise<Schedule | null> {
    for (;;) {
      const [due] = await this.store.listSchedules({ status: 'scheduled', dueBy: now.toISOString(), limit: 1 });
      if (!due) return null;
      const occurredAt = new Date().toISOString();
      const claimed = await this.store.transaction(async (store) => {
        if (!(await store.transition(due.scheduleId, { from: 'scheduled', status: 'dispatching', updatedAt: occurredAt }))) return null;
        return store.appendEvent({ scheduleId: due.scheduleId, eventType: 'claimed', status: 'dispatching', occurredAt });
      });
      if (!claimed) continue;
      const schedule = (await this.store.getSchedule(due.scheduleId))!;
      this.publish({ schedule, event: claimed });
      return schedule;
    }
  }

  async markDispatched(scheduleId: string, receipt?: ScheduleReceipt): Promise<Schedule> {
    return this.transition(scheduleId, ['dispatching'], 'dispatched', 'dispatched', undefined, receipt);
  }

  async fail(scheduleId: string, note: string): Promise<Schedule> {
    return this.transition(scheduleId, ['dispatching'], 'failed', 'failed', nonEmpty(note, 'failure'));
  }

  async get(scheduleId: string): Promise<Schedule | null> {
    return (await this.store.getSchedule(nonEmpty(scheduleId, 'scheduleId'))) ?? null;
  }

  async snapshot(): Promise<{ schedules: Schedule[]; lastEventSequence: number }> {
    const [schedules, lastEventSequence] = await Promise.all([this.store.listSchedules(), this.store.lastEventSequence()]);
    return { schedules, lastEventSequence };
  }

  async events(after = 0, limit = 200): Promise<ScheduleEvent[]> {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Scheduler cursor is invalid.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('Scheduler event limit must be from 1 to 1000.');
    }
    return this.store.readEvents(after, limit);
  }

  /**
   * A schedule left dispatching by a stopped Studio may or may not have run;
   * it is marked failed rather than run twice.
   */
  async recoverInterrupted(): Promise<void> {
    const note = 'dispatch outcome unknown after restart';
    for (const schedule of await this.store.listSchedules({ status: 'dispatching' })) {
      const occurredAt = new Date().toISOString();
      const event = await this.store.transaction(async (store) => {
        if (!(await store.transition(schedule.scheduleId, { from: 'dispatching', status: 'failed', note, updatedAt: occurredAt }))) return null;
        return store.appendEvent({ scheduleId: schedule.scheduleId, eventType: 'recovered', status: 'failed', note, occurredAt });
      });
      if (event) this.publish({ schedule: (await this.store.getSchedule(schedule.scheduleId))!, event });
    }
  }

  private async transition(
    scheduleId: string,
    allowed: readonly ScheduleStatus[],
    status: ScheduleStatus,
    eventType: ScheduleEvent['eventType'],
    note?: string,
    receipt?: ScheduleReceipt,
  ): Promise<Schedule> {
    const id = nonEmpty(scheduleId, 'scheduleId');
    const current = await this.store.getSchedule(id);
    if (!current) throw new Error(`Scheduler schedule "${id}" does not exist.`);
    if (!allowed.includes(current.status)) {
      throw new Error(`Scheduler schedule "${id}" is ${current.status}.`);
    }
    const occurredAt = new Date().toISOString();
    const event = await this.store.transaction(async (store) => {
      const changed = await store.transition(id, {
        from: current.status, status, updatedAt: occurredAt,
        ...(note === undefined ? {} : { note }),
        ...(receipt === undefined ? {} : { receipt }),
      });
      if (!changed) throw new Error(`Scheduler schedule "${id}" changed concurrently.`);
      return store.appendEvent({ scheduleId: id, eventType, status, ...(note === undefined ? {} : { note }), occurredAt });
    });
    const schedule = (await this.store.getSchedule(id))!;
    this.publish({ schedule, event });
    return schedule;
  }

  private publish(mutation: ScheduleMutation): void {
    for (const listener of this.listeners) {
      try {
        listener(mutation);
      } catch (error) {
        console.error(
          '[scheduler] committed domain-event listener failed:',
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
}
