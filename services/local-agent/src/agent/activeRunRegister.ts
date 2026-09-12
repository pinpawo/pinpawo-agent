import type { AgentRunView } from '@pinpawo/agent-session';

/** The run currently holding this Host, in the protocol's own shape. */
export type ActiveRun = Extract<AgentRunView, { state: 'running' }>;

/**
 * The one record of which run is in flight.
 *
 * A Host admits a single interactive connection and runs one turn at a time
 * (domains §一.3b), so this is single-valued. It exists because a snapshot has
 * to report the live run to a client that reconnects mid-turn — the
 * checkpoint cannot, since the run has not written one yet.
 *
 * `activity` is the opening value only. Clients derive the real activity from
 * the event stream (agent-session's reducer sets 'streaming' on a message
 * delta and 'using_tool' on a tool event), so a snapshot only has to say that
 * a run exists and when it started.
 *
 * It replaces two registers that held the same fact with different lifetimes:
 * resident's own activeRun, claimed around the whole admitted turn, and a
 * per-peer WeakMap claimed inside the admission. A snapshot had to consult
 * both and cross-check a third to decide which was true.
 */
export class ActiveRunRegister {
  private current: ActiveRun | null = null;

  /** The run in flight, or null. */
  read(): ActiveRun | null {
    return this.current;
  }

  /**
   * Claim the register for one run.
   *
   * Throws when a run already holds it: one Host runs one turn at a time, and
   * a second claim means an admission was bypassed rather than a race to
   * tolerate.
   */
  begin(requestId: string): ActiveRun {
    if (this.current) {
      throw new Error(`This Agent already has an active run "${this.current.requestId}".`);
    }
    const run: ActiveRun = {
      requestId,
      state: 'running',
      activity: 'thinking',
      startedAt: Date.now(),
    };
    this.current = run;
    return run;
  }

  /** Release the register, if this run still holds it. */
  finish(run: ActiveRun): void {
    if (this.current === run) {
      this.current = null;
    }
  }

  /** Release unconditionally, for a Host tearing down. */
  clear(): void {
    this.current = null;
  }
}
