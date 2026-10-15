export type ScheduleStatus = 'scheduled' | 'dispatching' | 'dispatched' | 'failed' | 'cancelled';

/** Host's receipt for the run a schedule started; sessionId is set for a Channel run. */
export type ScheduleReceipt = { invocationId: string; sessionId?: string };

export type Schedule = {
  scheduleId: string;
  petId: string;
  /** Run the Pet in this Channel instead of a bare dispatch. */
  channelId?: string;
  request: string;
  runAt: string;
  status: ScheduleStatus;
  note?: string;
  receipt?: ScheduleReceipt;
  createdAt: string;
  updatedAt: string;
};

export type ScheduleEvent = {
  sequence: number;
  scheduleId: string;
  eventType: 'created' | 'claimed' | 'dispatched' | 'failed' | 'cancelled' | 'recovered';
  status: ScheduleStatus;
  note?: string;
  occurredAt: string;
};

/** A status change, applied only while the schedule still has status `from`. */
export type ScheduleTransition = {
  from: ScheduleStatus;
  status: ScheduleStatus;
  /** Replaces the note; absent clears it. */
  note?: string;
  receipt?: ScheduleReceipt;
  updatedAt: string;
};

/**
 * Scheduler persistence. Data operations only; the rules (which transitions
 * are allowed, recovery, events) belong to SchedulerService above it.
 */
export interface ScheduleStore {
  /** Runs `work` atomically against the store it is given; nested calls join the outer transaction. */
  transaction<T>(work: (store: ScheduleStore) => Promise<T>): Promise<T>;
  insertSchedule(schedule: Schedule): Promise<void>;
  getSchedule(scheduleId: string): Promise<Schedule | undefined>;
  /** In run order. */
  listSchedules(filter?: { status?: ScheduleStatus; dueBy?: string; limit?: number }): Promise<Schedule[]>;
  /** Returns false when the schedule no longer has status `from`. */
  transition(scheduleId: string, change: ScheduleTransition): Promise<boolean>;
  appendEvent(event: Omit<ScheduleEvent, 'sequence'>): Promise<ScheduleEvent>;
  readEvents(after: number, limit: number): Promise<ScheduleEvent[]>;
  lastEventSequence(): Promise<number>;
}
