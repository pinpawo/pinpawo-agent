export type TriggerDeliveryStatus = 'dispatching' | 'accepted' | 'failed';

/** Host's receipt for the run a delivery started; sessionId is set for a Channel run. */
export type TriggerDeliveryReceipt = { invocationId: string; sessionId?: string };

export type TriggerDelivery = {
  deliveryId: string;
  triggerId: string;
  idempotencyKey: string;
  /** Retained only so a failed delivery can be retried without reconstructing its event. */
  targetPetId?: string;
  request?: string;
  status: TriggerDeliveryStatus;
  note?: string;
  receipt?: TriggerDeliveryReceipt;
  occurredAt: string;
  updatedAt: string;
};

export type TriggerDeliveryEvent = {
  sequence: number;
  deliveryId: string;
  triggerId: string;
  eventType: 'received' | 'accepted' | 'failed' | 'recovered' | 'retried' | 'redelivered';
  status: TriggerDeliveryStatus;
  note?: string;
  occurredAt: string;
};

/** A status change, applied only while the delivery still has status `from`. */
export type TriggerDeliveryTransition = {
  from: TriggerDeliveryStatus;
  status: TriggerDeliveryStatus;
  /** Replaces the note; absent clears it. */
  note?: string;
  /** Kept as is when absent. */
  receipt?: TriggerDeliveryReceipt;
  updatedAt: string;
};

/**
 * Trigger persistence. Data operations only; the rules (deduplication,
 * allowed transitions, recovery, events) belong to TriggerService above it.
 */
export interface TriggerStore {
  /** Runs `work` atomically against the store it is given; nested calls join the outer transaction. */
  transaction<T>(work: (store: TriggerStore) => Promise<T>): Promise<T>;
  /** Returns false, inserting nothing, when the trigger already has a delivery with this idempotency key. */
  insertDelivery(delivery: TriggerDelivery): Promise<boolean>;
  getDelivery(deliveryId: string): Promise<TriggerDelivery | undefined>;
  findDelivery(triggerId: string, idempotencyKey: string): Promise<TriggerDelivery | undefined>;
  /** Newest first. */
  listDeliveries(filter?: { status?: TriggerDeliveryStatus; limit?: number }): Promise<TriggerDelivery[]>;
  /** Returns false when the delivery no longer has status `from`. */
  transition(deliveryId: string, change: TriggerDeliveryTransition): Promise<boolean>;
  appendEvent(event: Omit<TriggerDeliveryEvent, 'sequence'>): Promise<TriggerDeliveryEvent>;
  readEvents(after: number, limit: number): Promise<TriggerDeliveryEvent[]>;
  lastEventSequence(): Promise<number>;
}
