import createMessageQueue from 'mqemitter';

import type { StudioEvent, StudioEventHandler } from './studioContract';

const STUDIO_EVENT_TOPIC = 'studio/event';

type MessageQueue = ReturnType<typeof createMessageQueue>;
type MessageQueueListener = Parameters<MessageQueue['on']>[1];
type StudioEventMessage = Parameters<MessageQueue['emit']>[0] & {
  topic: typeof STUDIO_EVENT_TOPIC;
  event: StudioEvent;
};

type StudioEventSubscription = {
  owner?: string;
  active: boolean;
  listener: MessageQueueListener;
  deliveryTail: Promise<void>;
};

/** Process-local Plugin event bus owned by Studio core. */
export class StudioEventBus {
  private readonly queue = createMessageQueue({ concurrency: 1 });
  private readonly pendingDeliveries = new Set<Promise<void>>();
  private readonly subscriptions = new Set<StudioEventSubscription>();
  private closed = false;

  publish(event: StudioEvent): void {
    if (this.closed) throw new Error('Studio event bus is closed.');
    const delivery = new Promise<void>((resolve, reject) => {
      this.queue.emit({ topic: STUDIO_EVENT_TOPIC, event }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    this.pendingDeliveries.add(delivery);
    void delivery
      .catch((error) => {
        console.error(
          `[studio] event delivery failed (type=${event.type}, source=${event.source}):`,
          error instanceof Error ? error.message : error,
        );
      })
      .finally(() => this.pendingDeliveries.delete(delivery));
  }

  subscribe(handler: StudioEventHandler, owner?: string): () => void {
    if (this.closed) throw new Error('Studio event bus is closed.');
    let subscription: StudioEventSubscription;
    const listener: MessageQueueListener = (message, done) => {
      if (!subscription.active) {
        done();
        return;
      }
      const { event } = message as StudioEventMessage;
      subscription.deliveryTail = subscription.deliveryTail.then(async () => {
        if (!subscription.active) return;
        try {
          await handler(event);
        } catch (error) {
          console.error(
            `[studio] event handler failed (type=${event.type}, source=${event.source}):`,
            error instanceof Error ? error.message : error,
          );
        }
      });
      // mqemitter coordinates publication only. Handler work stays on this
      // subscriber's FIFO so a slow transport cannot block unrelated Plugins.
      done();
    };
    subscription = {
      ...(owner ? { owner } : {}),
      active: true,
      listener,
      deliveryTail: Promise.resolve(),
    };
    this.subscriptions.add(subscription);
    this.queue.on(STUDIO_EVENT_TOPIC, listener);
    return () => this.removeSubscription(subscription);
  }

  releaseOwner(owner: string): void {
    for (const subscription of [...this.subscriptions]) {
      if (subscription.owner === owner) this.removeSubscription(subscription);
    }
  }

  private removeSubscription(subscription: StudioEventSubscription): void {
    if (!subscription.active) return;
    subscription.active = false;
    this.subscriptions.delete(subscription);
    this.queue.removeListener(STUDIO_EVENT_TOPIC, subscription.listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => this.queue.close(resolve));
    await Promise.allSettled([...this.pendingDeliveries]);
    for (const subscription of [...this.subscriptions]) {
      this.removeSubscription(subscription);
    }
  }
}
