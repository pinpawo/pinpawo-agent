import { ChannelAccessError, type ChannelMessage, type ChannelService } from './channelService';
import type { ChannelConsumptionRow } from './store/channelStore';

/** Frozen logical range. The original public messages remain separate and unchanged. */
export type ChannelTimelineBatch = {
  readonly progress: Readonly<ChannelConsumptionRow>;
  readonly throughSequence: number;
  readonly messages: readonly ChannelMessage[];
  /** Aborted when this instance deactivates or the consumer stops. Processing must honor it before side effects. */
  readonly signal: AbortSignal;
};
export type ChannelTimelineConsumerOptions = {
  service: ChannelService;
  /** Resolving acknowledges this range, not completion of an execution or exactly-once delivery. */
  consume: (batch: ChannelTimelineBatch) => Promise<void>;
  /** Fixed window from the first wake; subsequent posts do not extend the deadline. Default: 300 ms. */
  cooldownMs?: number;
  /** Original messages per batch, including rows the processing policy may skip. Default: 50, maximum: 200. */
  batchLimit?: number;
  onError?: (failure: { channelId: string; petId: string; error: unknown }) => void;
};

type HeadState = {
  channelId: string;
  petId: string;
  // Repeated wakes coalesce, including while processing owns this key.
  dirty: boolean;
  timer?: ReturnType<typeof setTimeout>;
  processing?: { controller: AbortController; done: Promise<void> };
};

/**
 * Channel-owned scheduling only: no model, session reads or dispatch. An explicit
 * processing callback owns relevance and effects. One instance serializes each
 * (Channel, Pet); it is not a distributed worker lease. Failed callbacks retain
 * progress and wait for another wake or a new start, without automatic retries.
 * Not installed by the Channel Plugin until its Head policy is supplied.
 */
export class ChannelTimelineConsumer {
  private readonly heads = new Map<string, HeadState>();
  private readonly cooldownMs: number;
  private readonly batchLimit: number;
  private unsubscribe?: () => void;
  private unsubscribeInvalidation?: () => void;
  private unsubscribeActivation?: () => void;
  private readonly processing = new Set<Promise<void>>();
  private active = false;
  private stopped = false;
  private starting?: Promise<void>;

  constructor(private readonly options: ChannelTimelineConsumerOptions) {
    this.cooldownMs = options.cooldownMs ?? 300;
    this.batchLimit = options.batchLimit ?? 50;
    if (!Number.isSafeInteger(this.cooldownMs) || this.cooldownMs < 0 || this.cooldownMs > 60_000) {
      throw new RangeError('Timeline cooldown must be an integer between 0 and 60000 ms.');
    }
    if (!Number.isSafeInteger(this.batchLimit) || this.batchLimit < 1 || this.batchLimit > 200) {
      throw new RangeError('Timeline batch limit must be an integer between 1 and 200.');
    }
  }

  /** Subscribe first, then discover existing progress without relying on a connected Console. */
  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Timeline consumer has stopped.'));
    if (this.starting) return this.starting;
    if (this.active) return Promise.resolve();
    this.active = true;
    this.unsubscribeInvalidation = this.options.service.subscribeConsumptionInvalidation((channelId, petId) => this.cancel(channelId, petId));
    this.unsubscribeActivation = this.options.service.subscribeConsumptionActivation((channelId, petId) => this.wakeInstance(channelId, petId));
    this.unsubscribe = this.options.service.subscribe(event => {
      if (event.type === 'channel.member.left' && event.payload.member.kind === 'pet') {
        this.cancel(event.payload.channelId, event.payload.member.id);
        return;
      }
      const channelId = event.type === 'channel.created' || event.type === 'channel.updated'
        ? event.payload.channel.channelId : event.payload.channelId;
      if (event.type === 'channel.message.created' || event.type === 'channel.created' || event.type === 'channel.member.joined') {
        void this.wake(channelId).catch(error => this.report(channelId, undefined, error));
      }
    });
    this.starting = this.discover().catch(error => {
      this.active = false;
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.unsubscribeInvalidation?.();
      this.unsubscribeInvalidation = undefined;
      this.unsubscribeActivation?.();
      this.unsubscribeActivation = undefined;
      for (const head of this.heads.values()) this.cancel(head.channelId, head.petId);
      throw error;
    }).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  /** A new wake also permits one retry of a previously failed range. */
  async wake(channelId: string): Promise<void> {
    if (!this.active) return;
    const members = await this.options.service.members(channelId);
    if (!this.active) return;
    for (const member of members) {
      if (member.kind !== 'pet') continue;
      this.wakeInstance(channelId, member.id);
    }
  }

  private wakeInstance(channelId: string, petId: string): void {
    if (!this.active || !this.options.service.isLiveOwner(channelId, petId)) return;
    const key = this.key(channelId, petId);
    let head = this.heads.get(key);
    if (!head) {
      head = { channelId, petId, dirty: false };
      this.heads.set(key, head);
    }
    head.dirty = true;
    this.schedule(head);
  }

  /** Stop waiting timers, abort in-flight callbacks, and wait for those callbacks to settle. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.active = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeInvalidation?.();
    this.unsubscribeInvalidation = undefined;
    this.unsubscribeActivation?.();
    this.unsubscribeActivation = undefined;
    for (const head of [...this.heads.values()]) this.cancel(head.channelId, head.petId);
    await this.starting?.catch(() => {});
    await Promise.all([...this.processing]);
    this.heads.clear();
  }

  private key(channelId: string, petId: string): string { return JSON.stringify([channelId, petId]); }

  private async discover(): Promise<void> {
    let after = 0;
    while (this.active) {
      const page = await this.options.service.store.listChannels({}, { after, limit: 100 });
      await Promise.all(page.items.map(channel => this.wake(channel.channelId)));
      if (!page.hasMore) return;
      after = page.nextAfter;
    }
  }

  private cancel(channelId: string, petId: string): void {
    const head = this.heads.get(this.key(channelId, petId));
    if (!head) return;
    head.dirty = false;
    clearTimeout(head.timer);
    head.timer = undefined;
    head.processing?.controller.abort();
    // A callback may ignore abort. Detach its generation immediately so a
    // later activation is never blocked by, or modified by, that callback.
    this.heads.delete(this.key(channelId, petId));
  }

  private schedule(head: HeadState): void {
    // A key is either waiting on its fixed window or processing, never both.
    if (!this.active || head.timer || head.processing || !head.dirty) return;
    head.timer = setTimeout(() => {
      head.timer = undefined;
      // Taking the key clears dirty. A wake during this activation marks it
      // again; settlement permits one follow-up window for the same generation.
      head.dirty = false;
      const controller = new AbortController();
      const done = this.consume(head, controller.signal).catch(error => {
        // Failure consumes wakes from this attempt, so it cannot hot-loop.
        if (!controller.signal.aborted) {
          head.dirty = false;
          this.report(head.channelId, head.petId, error);
        }
      }).finally(() => {
        this.processing.delete(done);
        head.processing = undefined;
        if (this.heads.get(this.key(head.channelId, head.petId)) === head) this.schedule(head);
      });
      this.processing.add(done);
      head.processing = { controller, done };
    }, this.cooldownMs);
  }

  private async consume(head: HeadState, signal: AbortSignal): Promise<void> {
    const service = this.options.service;
    let progress: ChannelConsumptionRow;
    try { progress = await service.consumption(head.channelId, head.petId); }
    catch (error) { if (error instanceof ChannelAccessError) return; throw error; }
    const page = await service.store.readMessages(head.channelId, { after: progress.afterSequence, limit: this.batchLimit });
    if (signal.aborted || !page.items.length) return;
    const current = await service.store.getConsumption(head.channelId, head.petId);
    // Deactivation/stop may happen during the final awaited activation read.
    if (signal.aborted || !this.active) return;
    if (!service.isConsumptionCurrent(progress, current)) {
      head.dirty = true;
      return;
    }
    // Capture before processing: a callback's public reply or a concurrent
    // post must never move this acknowledgement past the frozen batch end.
    const throughSequence = page.items.at(-1)!.sequence;
    await this.options.consume(Object.freeze({
      progress: Object.freeze({ ...progress }), throughSequence, messages: page.items, signal,
    }));
    if (signal.aborted || !this.active) return;
    const advanced = await service.advanceConsumption(progress, throughSequence);
    if (advanced && page.hasMore) head.dirty = true;
  }

  private report(channelId: string, petId: string | undefined, error: unknown): void {
    try {
      if (this.options.onError && petId) this.options.onError({ channelId, petId, error });
      else console.error('[channel] Timeline consumer failed.', { channelId, ...(petId ? { petId } : {}) });
    } catch { /* A reporting callback cannot break another Head's progress. */ }
  }
}
