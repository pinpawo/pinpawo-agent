/**
 * Admission for operations that change session state.
 *
 * Creating a session, resuming one, compacting it and switching its model all
 * change state the Session domain owns, so they are admitted here rather than
 * at whichever transport the request arrived on. Two rules, both previously
 * open-coded at each call site:
 *
 * - a session transition and a chat run never overlap;
 * - transitions never overlap each other.
 *
 * This is deliberately not connection-scoped. One Pet can hold several peers
 * (`peers: Set<AgentSessionPeer>`), so serializing per connection would not
 * stop a second connection from transitioning the same session — which is why
 * ordering a connection's own messages (ServerSessionCommandQueue) and
 * admitting a state change are kept apart.
 */
export class SessionAdmission {
  /**
   * Tail of the transition chain. Each transition appends to it, so they run
   * one after another; the chain is what runs wait on. Appending happens
   * synchronously, before any await, or two callers arriving in the same tick
   * would both find the session idle.
   */
  private transitions: Promise<void> = Promise.resolve();
  private activeRuns = 0;

  /** Whether a chat run currently holds the session. */
  hasActiveRun() {
    return this.activeRuns > 0;
  }

  /** Wait for queued transitions to settle. */
  async waitForIdle() {
    let seen: Promise<void> | null = null;
    // A transition can be appended while awaiting an earlier one, so wait
    // until the tail stops moving.
    while (this.transitions !== seen) {
      seen = this.transitions;
      await seen;
    }
  }

  /**
   * Run `operation` as a session transition, or `onRunActive` when a chat run
   * holds the session.
   *
   * The run check happens when this transition reaches the front of the
   * chain, not when it was queued: a run may have started in between.
   */
  transact<T>(
    operation: () => Promise<T>,
    onRunActive: () => T | Promise<T>,
  ): Promise<T> {
    const result = this.transitions.then(() => (
      this.hasActiveRun() ? onRunActive() : operation()
    ));
    // The chain must survive a failing transition, so it follows the
    // settlement rather than the value.
    this.transitions = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * Hold the session for one chat run, blocking transitions for its duration.
   */
  async runInSession<T>(operation: () => Promise<T>): Promise<T> {
    // Transitions queued ahead of this run go first, and the hold is taken
    // only once the run actually starts — matching the behaviour this
    // replaced, where the counter was raised after the transition wait.
    //
    // So a run queued behind a transition does not refuse it. What the hold
    // protects is the window while the run is executing.
    //
    // Runs do not join the transition chain: several may hold the session at
    // once, and each releases its own hold.
    await this.waitForIdle();
    this.activeRuns += 1;
    try {
      return await operation();
    } finally {
      this.activeRuns -= 1;
    }
  }
}
