/**
 * Post-interaction settle driver for `browser_click` / `browser_type` /
 * `browser_scroll` (issue #583, step 4).
 *
 * The Runtime must wait for the page the action produced before returning a
 * snapshot, instead of only trusting a single re-read. This module is the pure,
 * I/O-free counterpart of `openReadiness`: it drives an interaction's buffered
 * lifecycle events through a `BrowserLifecycleController` and decides how the
 * page settled. The extension reports the raw events; this driver decides the
 * outcome:
 *
 * - `nav_generation`: a *new* navigation started (a `navigation.committed` of a
 *   newer generation than the pre-action generation) — the caller should drive
 *   that navigation to full readiness.
 * - `settled`: no new navigation, and the page is readable (or cross-origin /
 *   target failure) from the interaction's own re-read plus the buffered events.
 * - `pending`: events ended before a verdict and before the deadline — the
 *   caller keeps polling (page still hydrating after the action).
 *
 * It never sleeps and owns no timers (same contract as `openReadiness`): the
 * caller owns the clock and the deadline.
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
  now?: () => number;
};

/**
 * Drive a post-action settle over the interaction's buffered events.
 *
 * `controller` must already have a navigation pending (bound to the bridge's
 * current generation). `events` are in chronological order. When any event
 * belongs to a *newer* navigation generation than the one the controller is
 * bound to, the action started a new navigation and the caller should hand off
 * to full readiness (return `nav_generation`). Otherwise the events are folded
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
  const bound = controller.getSnapshot().navigation?.generation;
  let now = startTime;

  for (const event of events) {
    now = Math.max(now, typeof event.timestamp === 'number' ? event.timestamp : now);

    // A navigation event stamped with a newer generation than the current one
    // means the action triggered a new navigation; hand off to full readiness.
    if (
      bound !== undefined
      && bound !== null
      && event.navigationGeneration !== undefined
      && event.navigationGeneration > bound
    ) {
      return { status: 'nav_generation', snapshot: controller.getSnapshot() };
    }

    controller.handleEvent(event);
    // Evaluate readiness after folding each event into the current navigation
    // (mirrors `driverOpenReadiness`), so a page that becomes readable mid-batch
    // is reported as `settled` rather than surfacing only on a later poll.
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

    if ((options.now ? options.now() : now) >= deadline) {
      const late = controller.getSnapshot();
      if (late.navigation?.phase !== 'readable') {
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
