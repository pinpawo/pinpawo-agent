import createMessageQueue from 'mqemitter';

import type { StudioEvent, StudioEventHandler } from './studioContract';

const STUDIO_EVENT_TOPIC = 'studio/event';

type MessageQueue = ReturnType<typeof createMessageQueue>;
type MessageQueueListener = Parameters<MessageQueue['on']>[1];
type StudioEventMessage = Parameters<MessageQueue['emit']>[0] & {
  topic: typeof STUDIO_EVENT_TOPIC;
  event: StudioEvent;
};

/** Process-local Plugin event bus owned by Studio core. */
export class StudioEventBus {
  private readonly queue = createMessageQueue({ concurrency: 1 });
  private readonly pendingDeliveries = new Set<Promise<void>>();
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

  subscribe(handler: StudioEventHandler): () => void {
    if (this.closed) throw new Error('Studio event bus is closed.');
    let active = true;
    const listener: MessageQueueListener = (message, done) => {
      if (!active) {
        done();
        return;
      }
      const { event } = message as StudioEventMessage;
      void Promise.resolve()
        .then(() => handler(event))
        .catch((error) => {
          console.error(
            `[studio] event handler failed (type=${event.type}, source=${event.source}):`,
            error instanceof Error ? error.message : error,
          );
        })
        .finally(done);
    };
    this.queue.on(STUDIO_EVENT_TOPIC, listener);
    return () => {
      if (!active) return;
      active = false;
      this.queue.removeListener(STUDIO_EVENT_TOPIC, listener);
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => this.queue.close(resolve));
    await Promise.allSettled([...this.pendingDeliveries]);
  }
}
