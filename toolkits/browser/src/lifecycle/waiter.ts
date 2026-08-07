/**
 * Pending-waiter management for Browser Runtime operations.
 *
 * A single deadline owns every waiting operation. The operation driver calls
 * `settle(value)` when the page reaches the target state (event-driven), and
 * the waiter also resolves on an explicit cancel (AbortSignal) or after the
 * deadline elapses. Each run resolves exactly once; cancellation is cooperative
 * and never replays work.
 */

export type WaitOutcome<T> =
  | { status: 'resolved'; value: T }
  | { status: 'cancelled' }
  | { status: 'timed_out' };

export type PendingWaitOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
};

export class PendingWait<T> {
  private settled = false;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly signal?: AbortSignal;
  private readonly onAbort: () => void;
  private resolveDone!: (outcome: WaitOutcome<T>) => void;
  readonly done: Promise<WaitOutcome<T>>;

  constructor(options: PendingWaitOptions) {
    this.signal = options.signal;
    this.done = new Promise<WaitOutcome<T>>((resolve) => {
      this.resolveDone = resolve;
    });
    this.onAbort = () => this.settleWith({ status: 'cancelled' });
    if (this.signal) {
      if (this.signal.aborted) {
        queueMicrotask(() => this.settleWith({ status: 'cancelled' }));
      } else {
        this.signal.addEventListener('abort', this.onAbort, { once: true });
      }
    }
    this.timeoutTimer = setTimeout(
      () => this.settleWith({ status: 'timed_out' }),
      Math.max(1, options.timeoutMs),
    );
  }

  /**
   * Event-driven: call with the latest value once the page reaches the awaited
   * state. Returns false if the waiter already settled (e.g. timed out).
   */
  settle(value: T): boolean {
    return this.settleWith({ status: 'resolved', value });
  }

  /**
   * Forfeit a still-pending wait as cancelled or timed out. Useful when the
   * operation driver itself detects an unrecoverable condition and wants to
   * release all waiters deterministically.
   */
  forfeit(status: 'cancelled' | 'timed_out'): boolean {
    return this.settleWith({ status });
  }

  private settleWith(outcome: WaitOutcome<T>): boolean {
    if (this.settled) return false;
    this.settled = true;
    this.cleanup();
    this.resolveDone(outcome);
    return true;
  }

  private cleanup(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    if (this.signal && !this.signal.aborted) {
      this.signal.removeEventListener('abort', this.onAbort);
    }
  }
}
