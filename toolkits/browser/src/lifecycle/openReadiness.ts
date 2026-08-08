/**
 * Standalone open-readiness orchestration for `browser_open`.
 *
 * The extension/CDP driver does not decide whether a navigation is "done" —
 * that is the Runtime's job (issue #583). This module provides a pure,
 * deterministic, I/O-free driver that walks an injected sequence of lifecycle
 * events through the `BrowserLifecycleController` and produces a single
 * readiness verdict. It handles the scenarios the issue cares about:
 *
 * - **Normal flow**: requested → committed → document.ready → settle → readable
 * - **Redirect**: a cross-origin commit fails the navigation (`origin_changed`)
 * - **Timeout**: the deadline elapses before the page becomes readable
 * - **SPA shell**: document is `complete` but body text has not been sampled —
 *   not readable until the body arrives (the volcengine scenario)
 * - **Long-lived connection**: a WebSocket/SSE that never reports inflight
 *   requests must not block readiness forever
 * - **SPA route change**: a same-origin commit while `readable` re-arms the
 *   readiness tracking for the newly committed document
 *
 * It is deliberately decoupled from any transport: callers feed events via
 * `feed` and advance the clock via `poll`, so it can be unit-tested in isolation
 * before any extension/CDP wiring lands. It never sleeps and owns no timers.
 *
 * Clock contract (issue #583 review): the driver enforces the readiness
 * deadline against the event timeline (`now`, which advances with each event's
 * `timestamp`), or against an injected clock (`options.now`) when one is
 * supplied. `startTime` and each event's `timestamp` share one clock domain
 * (the bridge stamps events with `Date.now`, so callers pass a corresponding
 * `startTime`). An event array ending early does
 * not by itself mean the deadline elapsed — the driver reports `timed_out` only
 * once the clock has actually passed the deadline, otherwise `pending`.
 */

import { BrowserLifecycleController, NAV_NAVIGATION_TIMEOUT_MS } from './controller';
import type { BrowserRuntimeEvent } from './events';
import type { BrowserRuntimeError } from './navigation';

export const OPEN_READINESS_DEADLINE_MS = NAV_NAVIGATION_TIMEOUT_MS;

export type OpenReadinessOutcome =
  | { status: 'readable'; snapshot: ReturnType<BrowserLifecycleController['getSnapshot']> }
  | {
      status: 'failed';
      error: BrowserRuntimeError;
      snapshot: ReturnType<BrowserLifecycleController['getSnapshot']>;
    }
  | {
      status: 'timed_out';
      snapshot: ReturnType<BrowserLifecycleController['getSnapshot']>;
    }
  | {
      /** The injected event sequence ended before a verdict and before the real
       *  deadline. The caller should keep polling past this point. */
      status: 'pending';
      snapshot: ReturnType<BrowserLifecycleController['getSnapshot']>;
    };

export type OpenReadinessOptions = {
  /** Wall-clock deadline (ms) by which the navigation must become readable. */
  deadlineMs?: number;
  /**
   * Injectable clock returning the current time in the same epoch/domain as
   * `startTime` and the events' `timestamp`. When omitted the driver is a
   * deterministic replay and the deadline is evaluated against the event
   * timeline. Supply one to reflect real elapsed time: a page that goes quiet
   * mid-navigation (no further events) is then reported as `timed_out` only
   * once the injected clock passes the deadline — never merely because the
   * input event array ended.
   */
  now?: () => number;
  /**
   * Optional decider for when to run a readiness poll. When omitted, every
   * `feed` call triggers an implicit poll at the event timestamp. Supplying one
   * lets the caller (test or driver) decide the sampling cadence precisely.
   */
  shouldPoll?: (event: BrowserRuntimeEvent, now: number) => boolean;
};

/**
 * Drives an injected sequence of navigation lifecycle events to a single
 * readiness verdict.
 *
 * `events` are expected in chronological order. Each is fed into the controller;
 * when the navigation becomes `failed` or `readable` the walk stops. The clock
 * starts at `startTime` and advances with each event's `timestamp`; the
 * deadline is checked against the event timeline, or against `options.now()`
 * when an injected clock is supplied.
 */
export function driveOpenReadiness(
  controller: BrowserLifecycleController,
  events: ReadonlyArray<BrowserRuntimeEvent>,
  startTime: number,
  options: OpenReadinessOptions = {},
): OpenReadinessOutcome {
  const deadlineMs = options.deadlineMs ?? OPEN_READINESS_DEADLINE_MS;
  const deadline = startTime + deadlineMs;
  let now = startTime;

  for (const event of events) {
    now = Math.max(now, typeof event.timestamp === 'number' ? event.timestamp : now);

    controller.handleEvent(event);

    const snapshot = controller.getSnapshot();
    const nav = snapshot.navigation;

    if (nav?.phase === 'failed') {
      return {
        status: 'failed',
        error: nav.error ?? { code: 'navigation_failed', message: 'navigation failed', retryable: false },
        snapshot,
      };
    }

    // Decide whether to run a readiness poll at this point.
    if (options.shouldPoll ? options.shouldPoll(event, now) : true) {
      controller.pollReadiness(now);
      const afterPoll = controller.getSnapshot();
      if (afterPoll.navigation?.phase === 'readable') {
        return { status: 'readable', snapshot: afterPoll };
      }
    }

    // Deadline check. Without an injected clock this is a deterministic replay,
    // so the deadline is evaluated against the event timeline `now`; with an
    // injected clock it reflects real elapsed time. In both cases the driver
    // refuses to keep walking past the deadline.
    const currentTime = options.now ? options.now() : now;
    if (currentTime >= deadline) {
      const late = controller.getSnapshot();
      if (late.navigation?.phase !== 'readable') {
        return { status: 'timed_out', snapshot: late };
      }
    }
  }

  // Ran out of events before reaching readable or failed. Only report
  // `timed_out` once the deadline has actually elapsed; ending the event array
  // early does not itself mean time expired.
  const final = controller.getSnapshot();
  if (final.navigation?.phase === 'readable') {
    return { status: 'readable', snapshot: final };
  }
  if (final.navigation?.phase === 'failed') {
    return {
      status: 'failed',
      error: final.navigation.error ?? { code: 'navigation_failed', message: 'navigation failed', retryable: false },
      snapshot: final,
    };
  }
  if ((options.now ? options.now() : now) >= deadline) {
    return { status: 'timed_out', snapshot: final };
  }
  return { status: 'pending', snapshot: final };
}

/**
 * Convenience: begin a navigation and synchronously drive it to a verdict,
 * returning a plain verdict without exposing the controller (for callers that
 * only need the outcome, e.g. tests or thin driver wrappers).
 */
export function evaluateOpenReadiness(
  events: ReadonlyArray<BrowserRuntimeEvent>,
  startTime: number,
  options: { requestedUrl: string; approvedOrigin: string; deadlineMs?: number } & OpenReadinessOptions,
): OpenReadinessOutcome {
  const controller = new BrowserLifecycleController();
  controller.beginNavigation(
    options.requestedUrl,
    options.approvedOrigin,
    events[0]?.connectionGeneration ?? 1,
    events[0]?.targetGeneration ?? 1,
  );
  return driveOpenReadiness(controller, events, startTime, options);
}
