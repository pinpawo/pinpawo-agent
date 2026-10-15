import type { Generated } from 'kysely';
import type { ScheduleEvent, ScheduleStatus } from '../scheduleStore';

/** The Scheduler's tables in the Studio database. */
export type SchedulerDatabase = {
  schedules: {
    schedule_id: string;
    pet_id: string;
    channel_id: string | null;
    request: string;
    run_at: string;
    status: ScheduleStatus;
    note: string | null;
    invocation_id: string | null;
    session_id: string | null;
    created_at: string;
    updated_at: string;
  };
  schedule_events: {
    sequence: Generated<number>;
    schedule_id: string;
    event_type: ScheduleEvent['eventType'];
    status: ScheduleStatus;
    note: string | null;
    occurred_at: string;
  };
};
