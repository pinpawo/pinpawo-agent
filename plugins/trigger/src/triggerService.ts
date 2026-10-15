import { randomUUID } from 'node:crypto';
import type {
  TriggerDelivery, TriggerDeliveryEvent, TriggerDeliveryReceipt, TriggerDeliveryStatus, TriggerStore,
} from './store/triggerStore';

export type {
  TriggerDelivery, TriggerDeliveryEvent, TriggerDeliveryReceipt, TriggerDeliveryStatus,
} from './store/triggerStore';

export type TriggerDeliveryMutation = {
  delivery: TriggerDelivery;
  event: TriggerDeliveryEvent;
};

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Trigger ${label} must not be empty.`);
  return normalized;
}

/**
 * Delivery rules over a TriggerStore: idempotent claims, allowed transitions,
 * retry and redelivery, and recovery of deliveries interrupted by a restart.
 * Notifications are best effort after commit.
 */
export class TriggerService {
  private readonly listeners = new Set<(mutation: TriggerDeliveryMutation) => void>();

  constructor(readonly store: TriggerStore) {}

  subscribe(listener: (mutation: TriggerDeliveryMutation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Records a delivery once per trigger and idempotency key; a repeat returns the first one. */
  async claim(triggerId: string, idempotencyKey: string, dispatch?: { targetPetId: string; request: string }): Promise<{
    delivery: TriggerDelivery;
    duplicate: boolean;
  }> {
    const normalizedTriggerId = nonEmpty(triggerId, 'triggerId');
    const normalizedKey = nonEmpty(idempotencyKey, 'idempotencyKey');
    const existing = await this.store.findDelivery(normalizedTriggerId, normalizedKey);
    if (existing) return { delivery: existing, duplicate: true };
    const now = new Date().toISOString();
    const delivery: TriggerDelivery = {
      deliveryId: randomUUID(),
      triggerId: normalizedTriggerId,
      idempotencyKey: normalizedKey,
      ...(dispatch === undefined ? {} : {
        targetPetId: nonEmpty(dispatch.targetPetId, 'targetPetId'),
        request: nonEmpty(dispatch.request, 'request'),
      }),
      status: 'dispatching',
      occurredAt: now,
      updatedAt: now,
    };
    const event = await this.store.transaction(async (store) => {
      if (!(await store.insertDelivery(delivery))) return null;
      return store.appendEvent({
        deliveryId: delivery.deliveryId, triggerId: delivery.triggerId, eventType: 'received', status: 'dispatching', occurredAt: now,
      });
    });
    if (!event) {
      // Another claim for the same key committed first.
      return { delivery: (await this.store.findDelivery(normalizedTriggerId, normalizedKey))!, duplicate: true };
    }
    this.publish({ delivery, event });
    return { delivery, duplicate: false };
  }

  async accept(deliveryId: string, receipt?: TriggerDeliveryReceipt): Promise<TriggerDelivery> {
    return this.transition(deliveryId, 'dispatching', 'accepted', 'accepted', undefined, receipt);
  }

  async fail(deliveryId: string, note: string): Promise<TriggerDelivery> {
    return this.transition(deliveryId, 'dispatching', 'failed', 'failed', nonEmpty(note, 'failure'));
  }

  async retry(deliveryId: string): Promise<TriggerDelivery> {
    const id = nonEmpty(deliveryId, 'deliveryId');
    const current = await this.store.getDelivery(id);
    if (!current || current.status !== 'failed') throw new Error(`Trigger delivery "${id}" is not retryable.`);
    if (!current.targetPetId || !current.request) throw new Error(`Trigger delivery "${id}" has no retained dispatch input.`);
    return this.transition(id, 'failed', 'dispatching', 'retried');
  }

  /**
   * Explicitly create a fresh delivery for an input that was accepted by the
   * resident admission queue. The original receipt remains immutable: an
   * operator must consciously request this because acceptance does not prove
   * whether a later runtime interruption occurred before useful work began.
   */
  async redeliver(deliveryId: string): Promise<TriggerDelivery> {
    const id = nonEmpty(deliveryId, 'deliveryId');
    const current = await this.store.getDelivery(id);
    if (!current || current.status !== 'accepted') {
      throw new Error(`Trigger delivery "${id}" is not accepted and cannot be redelivered.`);
    }
    if (!current.targetPetId || !current.request) {
      throw new Error(`Trigger delivery "${id}" has no retained dispatch input.`);
    }
    const now = new Date().toISOString();
    const nextId = randomUUID();
    const delivery: TriggerDelivery = {
      deliveryId: nextId,
      triggerId: current.triggerId,
      idempotencyKey: `${current.idempotencyKey}:redelivery:${nextId}`,
      targetPetId: current.targetPetId,
      request: current.request,
      status: 'dispatching',
      note: `Redelivery requested for accepted delivery ${id}.`,
      occurredAt: now,
      updatedAt: now,
    };
    const event = await this.store.transaction(async (store) => {
      if (!(await store.insertDelivery(delivery))) throw new Error(`Trigger delivery "${nextId}" already exists.`);
      return store.appendEvent({
        deliveryId: nextId, triggerId: current.triggerId, eventType: 'redelivered', status: 'dispatching',
        note: `Redelivered from ${id}.`, occurredAt: now,
      });
    });
    this.publish({ delivery, event });
    return delivery;
  }

  async snapshot(): Promise<{ deliveries: TriggerDelivery[]; lastEventSequence: number }> {
    const [deliveries, lastEventSequence] = await Promise.all([
      this.store.listDeliveries({ limit: 500 }),
      this.store.lastEventSequence(),
    ]);
    return { deliveries, lastEventSequence };
  }

  async getDelivery(deliveryId: string): Promise<TriggerDelivery | null> {
    return (await this.store.getDelivery(nonEmpty(deliveryId, 'deliveryId'))) ?? null;
  }

  async events(after = 0, limit = 200): Promise<TriggerDeliveryEvent[]> {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Trigger cursor is invalid.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('Trigger event limit must be from 1 to 1000.');
    }
    return this.store.readEvents(after, limit);
  }

  /**
   * A delivery left dispatching by a stopped Studio may or may not have
   * reached its Pet; it is marked failed so an operator can retry it.
   */
  async recoverInterrupted(): Promise<void> {
    const note = 'dispatch outcome unknown after restart';
    for (const delivery of await this.store.listDeliveries({ status: 'dispatching' })) {
      const occurredAt = new Date().toISOString();
      const event = await this.store.transaction(async (store) => {
        if (!(await store.transition(delivery.deliveryId, { from: 'dispatching', status: 'failed', note, updatedAt: occurredAt }))) return null;
        return store.appendEvent({
          deliveryId: delivery.deliveryId, triggerId: delivery.triggerId, eventType: 'recovered', status: 'failed', note, occurredAt,
        });
      });
      if (event) this.publish({ delivery: (await this.store.getDelivery(delivery.deliveryId))!, event });
    }
  }

  private async transition(
    deliveryId: string,
    from: TriggerDeliveryStatus,
    status: TriggerDeliveryStatus,
    eventType: TriggerDeliveryEvent['eventType'],
    note?: string,
    receipt?: TriggerDeliveryReceipt,
  ): Promise<TriggerDelivery> {
    const id = nonEmpty(deliveryId, 'deliveryId');
    const current = await this.store.getDelivery(id);
    if (!current || current.status !== from) throw new Error(`Trigger delivery "${id}" is not ${from}.`);
    const occurredAt = new Date().toISOString();
    const event = await this.store.transaction(async (store) => {
      const changed = await store.transition(id, {
        from, status, updatedAt: occurredAt,
        ...(note === undefined ? {} : { note }),
        ...(receipt === undefined ? {} : { receipt }),
      });
      if (!changed) throw new Error(`Trigger delivery "${id}" is not ${from}.`);
      return store.appendEvent({
        deliveryId: id, triggerId: current.triggerId, eventType, status, ...(note === undefined ? {} : { note }), occurredAt,
      });
    });
    const delivery = (await this.store.getDelivery(id))!;
    this.publish({ delivery, event });
    return delivery;
  }

  private publish(mutation: TriggerDeliveryMutation): void {
    for (const listener of this.listeners) {
      try {
        listener(mutation);
      } catch (error) {
        console.error(
          '[trigger] committed domain-event listener failed:',
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
}
