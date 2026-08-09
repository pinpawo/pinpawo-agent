/**
 * Post-interaction settle driver for `browser_click` / `browser_type` /
 * `browser_scroll` / `browser_submit` (issue #583, step 4).
 *
 * After any interaction, the page the action produced may keep changing: a click
 * can hydrate an SPA, start a new navigation, or only update the DOM. The
 * Runtime must wait for the produced page to *settle* before returning a
 * snapshot, instead of only trusting a single re-read. This module is the pure,
 * I/O-free counterpart of `openReadiness`: it drives an interaction's buffered
 * lifecycle events through a `BrowserLifecycleController` and decides how the
 * page settled.
 *
 * Outcome classification (mirrors the issue's tool semantics for interaction
 * tools):
 *
 * - `nav_generation`: a *new* navigation started (an event stamped with a newer
 *   navigation generation than the one the controller is bound to). The action
 *   caused a navigation, so the caller should drive that navigation to full
 *   readiness (the same path `browser_open` uses).
 * - `settled`: no new navigation, and the current page reached `readable` (or a
 *   cross-origin / target failure surfaced deterministically).
 * - `pending`: events ended before a verdict and before the deadline — the
 *   caller keeps polling (the page is still hydrating after the action).
 * - `timed_out`: the deadline elapsed before the page settled, with no terminal
 *   verdict. The caller surfaces `navigation_settle_timeout` with the phase /
 *   diagnostic snapshot.
 *
 * It never sleeps and owns no timers (the same contract as `openReadiness`):
 * the caller owns the clock, the deadline, and the sampling cadence via
 * `shouldPoll`.
 */
import { BrowserLifecycleController } from './controller';
import type { BrowserRuntimeEvent } from './events';
import type { BrowserRuntimeError } from './navigation';
import { OPEN_READINESS_DEADLINE_MS } from './openReadiness';

export const INTERACTION_SETTLE_DEADLINE_MS = OPEN_READINESS_DEADLINE_MS;

export type InteractionSettleOutcome =
  | { status: 'nav_generation'; snapshot: ReturnType<BrowserLifecycleController['getSnapshot']> }
  | {
      status: 'settled';
      snapshot: ReturnType<BrowserLifecycleController['getSnapshot']>;
    }
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
      status: 'pending';
      snapshot: ReturnType<BrowserLifecycleController['getSnapshot']>;
    };

export type InteractionSettleOptions = {
  /** Wall-clock deadline (ms) by which the action's page must settle. */
  deadlineMs?: number;
  /**
   * Injectable clock returning the current time in the same epoch/domain as
   * `startTime` and the events' `timestamp`. When omitted the driver is a
   * deterministic replay and the deadline is evaluated against the event
   * timeline. Supply one to reflect real elapsed time: a page that goes quiet
   * mid-settle (no further events) is then reported `timed_out` only once the
   * injected clock passes the deadline — never merely because the input event
   * array ended.
   */
  now?: () => number;
  /**
   * Optional decider for when to run a readiness poll. When omitted, this
   * driver polls once, on the last buffered event (the same cadence lesson as
   * `driveOpenReadiness`'s M1 fix: polling after *every* event re-runs
   * `advanceSettling` and resets the network-settle baseline each poll, so the
   * final poll's `now` equals the baseline it just wrote and the navigation
   * never reaches `readable` for a tightly-grouped event burst). Supplying one
   * lets the caller choose how the settle verdict is sampled.
   */
  shouldPoll?: (event: BrowserRuntimeEvent, now: number) => boolean;
};

/**
 * The navigation generation the controller is currently bound to, if any.
 * Used to detect whether an event starts a *new* navigation.
 */
function boundGeneration(controller: BrowserLifecycleController): number | null {
  return controller.getSnapshot().navigation?.generation ?? null;
}

/**
 * Drive a post-action settle over the interaction's buffered events.
 *
 * `controller` must already have a navigation pending (bound to the bridge's
 * current generation). `events` are in chronological order. When any event
 * belongs to a *newer* navigation generation than the one the controller is
 * bound to, the action started a new navigation and the caller should hand off
 * to full readiness (returns `nav_generation`). Otherwise the events are folded
 * into the current navigation and the verdict is `settled` when readable (or
 * `failed`), `pending` when the input ran out before the deadline.
 */
export function driveInteractionSettle(
  controller: BrowserLifecycleController,
  events: ReadonlyArray<BrowserRuntimeEvent>,
  startTime: number,
  options: InteractionSettleOptions = {},
): InteractionSettleOutcome {
  const deadlineMs = options.deadlineMs ?? INTERACTION_SETTLE_DEADLINE_MS;
  const deadline = startTime + deadlineMs;
  const bound = boundGeneration(controller);
  let now = startTime;

  // Poll only on the last event by default so a tightly-grouped interaction
  // event burst is evaluated against the fully-assembled state rather than
  // re-arming the settle window on every event (see InteractionSettleOptions).
  const last = events[events.length - 1];
  const shouldPoll = options.shouldPoll ?? ((event) => event === last);

  for (const event of events) {
    now = Math.max(now, typeof event.timestamp === 'number' ? event.timestamp : now);

    // A navigation-scoped event stamped with a *newer* generation than the one
    // this controller is bound to means the interaction started a new
    // navigation. Hand off to full readiness rather than folding it into the
    // pre-action navigation.
    if (
      bound !== null
      && event.navigationGeneration !== undefined
      && event.navigationGeneration > bound
    ) {
      return { status: 'nav_generation', snapshot: controller.getSnapshot() };
    }

    controller.handleEvent(event);

    // Evaluate readiness at this sampling point (default: the last event).
    if (shouldPoll(event, now)) {
      controller.pollReadiness(now);
      const snapshot = controller.getSnapshot();
      const nav = snapshot.navigation;
      if (nav?.phase === 'failed') {
        return {
          status: 'failed',
          error: nav.error ?? { code: 'navigation_failed', message: 'navigation failed', retryable: false },
          snapshot,
        };
      }
      if (nav?.phase === 'readable') {
        return { status: 'settled', snapshot };
      }
    }

    // Deadline check. Without an injected clock this is a deterministic replay,
    // so the deadline is evaluated against the event timeline `now`; with an
    // injected clock it reflects real elapsed time.
    const currentTime = options.now ? options.now() : now;
    if (currentTime >= deadline) {
      const late = controller.getSnapshot();
      if (late.navigation?.phase !== 'readable' && late.navigation?.phase !== 'failed') {
        return { status: 'timed_out', snapshot: late };
      }
    }
  }

  const final = controller.getSnapshot();
  if (final.navigation?.phase === 'readable') return { status: 'settled', snapshot: final };
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
