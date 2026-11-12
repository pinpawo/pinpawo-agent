import type { StudioEvent, StudioEventHandler } from './studioContract';

type StudioEventSubscription = {
  owner?: string;
  handler: StudioEventHandler;
  active: boolean;
};

/** Process-local, best-effort broadcast; it does not retain or replay events. */
export class StudioEventBus {
  private readonly subscriptions = new Set<StudioEventSubscription>();
  private closed = false;

  publish(event: StudioEvent): void {
    if (this.closed) throw new Error('Studio event bus is closed.');
    // Snapshot membership at publication. A handler may unsubscribe another
    // subscriber, but a new subscription must not receive this event.
    for (const subscription of [...this.subscriptions]) {
      if (!subscription.active) continue;
      try {
        const result = subscription.handler(event);
        void Promise.resolve(result).catch((error: unknown) => this.reportError(event, error));
      } catch (error) {
        this.reportError(event, error);
      }
    }
  }

  subscribe(handler: StudioEventHandler, owner?: string): () => void {
    if (this.closed) throw new Error('Studio event bus is closed.');
    const subscription: StudioEventSubscription = { ...(owner ? { owner } : {}), handler, active: true };
    this.subscriptions.add(subscription);
    return () => this.removeSubscription(subscription);
  }

  releaseOwner(owner: string): void {
    for (const subscription of [...this.subscriptions]) {
      if (subscription.owner === owner) this.removeSubscription(subscription);
    }
  }

  private removeSubscription(subscription: StudioEventSubscription): void {
    subscription.active = false;
    this.subscriptions.delete(subscription);
  }

  private reportError(event: StudioEvent, error: unknown): void {
    console.error(
      `[studio] event handler failed (type=${event.type}, source=${event.source}):`,
      error instanceof Error ? error.message : error,
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const subscription of [...this.subscriptions]) this.removeSubscription(subscription);
  }
}
