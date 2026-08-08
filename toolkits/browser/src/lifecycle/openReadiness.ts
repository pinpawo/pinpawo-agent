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
    };

export type OpenReadinessOptions = {
  /** Wall-clock deadline (ms) by which the navigation must become readable. */
  deadlineMs?: number;
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
 * starts at `startTime` and advances with each event's `timestamp` unless a
 * poll cadence is supplied via `options.shouldPoll`.
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

    // Deadline sanity check — refuse to keep walking past the deadline.
    if (now >= deadline) {
      const late = controller.getSnapshot();
      if (late.navigation?.phase !== 'readable') {
        return { status: 'timed_out', snapshot: late };
      }
    }
  }

  // Ran out of events before reaching readable or failed.
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
  return { status: 'timed_out', snapshot: final };
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
