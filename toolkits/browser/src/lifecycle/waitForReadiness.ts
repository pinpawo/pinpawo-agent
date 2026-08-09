/**
 * Live readiness wait for `browser_open` backed by a `PendingWait`.
 *
 * Issue #583 / #601: the *Runtime* owns the wait for a navigation to become
 * readable — not only the extension's `tab.status` polling. The extension
 * reports raw page-lifecycle events through the bridge; this module subscribes
 * to that live stream, feeds each event into a `BrowserLifecycleController`,
 * and waits via a `PendingWait`:
 *
 * - `resolved`  → the navigation reached `readable`.
 * - `failed`    → the navigation terminally failed (`origin_changed`,
 *                 `target_closed`, `runtime_disconnected`, …). The structured
 *                 error plus phase/URL/readyState diagnostics is returned.
 * - `timed_out` → the wall-clock deadline elapsed before readiness. The result
 *                 carries the phase / committed URL / readyState the page was
 *                 in, so the caller can distinguish "still hydrating" from a
 *                 slow page and guide the user to `browser_wait`.
 *
 * Semantics: the wait terminates deterministically through `PendingWait` —
 * `settle` on readable, `forfeit('cancelled')` on failure (so it reads as an
 * explicit terminal set rather than a timeout), and the built-in `timed_out`
 * on wall-clock expiry. Each run resolves exactly once.
 *
 * Unlike the synchronous replayers (`openReadiness` / `interactionSettle`),
 * this module owns no event array: it reacts to a live stream. Callers that
 * only need to replay a recorded sequence should keep using those drivers.
 */

import { BrowserLifecycleController } from './controller';
import { PendingWait } from './waiter';
import type { BrowserRuntimeEvent } from './events';
import type { BrowserRuntimeError } from './navigation';
import { OPEN_READINESS_DEADLINE_MS } from './openReadiness';

export const WAIT_FOR_READINESS_DEADLINE_MS = OPEN_READINESS_DEADLINE_MS;

/** The minimal live event/generation source this wait consumes (the same shape
 *  `bindBridgeToController` needs). */
export type ReadinessEventSource = {
  onRuntimeEvent(listener: (event: BrowserRuntimeEvent) => void): () => void;
  onGenerationChanged(listener: (change: {
    connectionGeneration: number;
    targetGeneration: number;
  }) => void): () => void;
};

export type ReadinessDiagnostics = Readonly<{
  phase: string | null;
  committedUrl?: string;
  readyState?: string;
  inflightRequests?: number;
  textLength?: number;
}>;

export type ReadinessFailure = {
  error: BrowserRuntimeError;
  diagnostics: ReadinessDiagnostics;
};

export type ReadinessTimeout = {
  diagnostics: ReadinessDiagnostics;
};

export type WaitForReadinessResult =
  | { status: 'resolved'; snapshot: ReturnType<BrowserLifecycleController['getSnapshot']> }
  | {
      status: 'failed';
      failure: ReadinessFailure;
      snapshot: ReturnType<BrowserLifecycleController['getSnapshot']>;
    }
  | {
      status: 'timed_out';
      timeout: ReadinessTimeout;
      snapshot: ReturnType<BrowserLifecycleController['getSnapshot']>;
    };

export type WaitForReadinessOptions = {
  /** Wall-clock deadline (ms) by which the navigation must become readable. */
  deadlineMs?: number;
  /** Live event/generation source to subscribe to (matches
   *  `bindBridgeToController`). When omitted callers drive the controller
   *  themselves and poll; the wait then resolves only via the wall-clock
   *  timeout once the timer fires. */
  source?: ReadinessEventSource;
  /** Injectable clock used for the final-diagnostics sampling and optional
   *  wall-clock start reference. When omitted `Date.now()` is used. */
  now?: () => number;
};

function diagnosticsFromSnapshot(
  snapshot: ReturnType<BrowserLifecycleController['getSnapshot']>,
): ReadinessDiagnostics {
  const nav = snapshot.navigation;
  if (!nav) return { phase: null };
  return {
    phase: nav.phase,
    ...(nav.committedUrl !== undefined ? { committedUrl: nav.committedUrl } : {}),
    ...(nav.readyState !== undefined ? { readyState: nav.readyState } : {}),
    ...(nav.inflightRequests !== undefined ? { inflightRequests: nav.inflightRequests } : {}),
  };
}

/** A started readiness wait. Exposes a `finished` promise and a `feed` handle
 *  so callers can both stream live events and await the terminal result. */
export type ReadinessWait = {
  finished: Promise<WaitForReadinessResult>;
  /** Feed a single live lifecycle event into the controller and re-evaluate
   *  readiness. Safe to call after settlement (no-op). */
  feed(event: BrowserRuntimeEvent): void;
  /** Signal a bridge generation bump (reconnect / target close). Resolves a
   *  still-pending wait deterministically to `failed`. */
  generationChanged(connectionGeneration: number, targetGeneration: number): void;
  /** Unsubscribe the live event/generation subscriptions. Idempotent. */
  dispose(): void;
};

/**
 * Start waiting for a navigation to become `readable` on a live readiness
 * stream.
 *
 * `controller` should already have a navigation pending (`beginNavigation`).
 * When `options.source` is provided it is subscribed so that live events and
 * generation bumps drive the wait to resolution or deterministic failure. Each
 * live event is fed to the controller; once the controller reaches `readable`
 * or `failed` the `PendingWait` settles / is forfeited. On wall-clock expiry it
 * resolves `timed_out` with phase/URL/readyState diagnostics (to guide the
 * user toward `browser_wait`).
 *
 * The returned `ReadinessWait` also exposes `feed` / `generationChanged` /
 * `dispose`, so a caller that owns the transport (rather than subscribing here)
 * can stream events explicitly and tear down cleanly.
 */
export function waitForReadiness(
  controller: BrowserLifecycleController,
  options: WaitForReadinessOptions = {},
): ReadinessWait {
  const deadlineMs = options.deadlineMs ?? WAIT_FOR_READINESS_DEADLINE_MS;
  const clock = options.now ?? (() => Date.now());

  const waiter = new PendingWait<WaitForReadinessResult>({ timeoutMs: deadlineMs });

  let settledResult: WaitForReadinessResult | null = null;

  const materialize = (
    status: WaitForReadinessResult['status'],
  ): WaitForReadinessResult => {
    const snapshot = controller.getSnapshot();
    const nav = snapshot.navigation;
    if (status === 'resolved') {
      return { status: 'resolved', snapshot };
    }
    if (status === 'failed') {
      const error = nav?.error ?? {
        code: 'navigation_failed',
        message: 'navigation failed',
        retryable: false,
      };
      return { status: 'failed', failure: { error, diagnostics: diagnosticsFromSnapshot(snapshot) }, snapshot };
    }
    return {
      status: 'timed_out',
      timeout: { diagnostics: diagnosticsFromSnapshot(snapshot) },
      snapshot,
    };
  };

  const finish = (status: WaitForReadinessResult['status']): void => {
    if (settledResult) return;
    settledResult = materialize(status);
    if (status === 'resolved') {
      waiter.settle(settledResult);
    } else {
      waiter.forfeit(status === 'failed' ? 'cancelled' : 'timed_out');
    }
  };

  // Run once readiness is reached or the deadline elapses. `PendingWait` settles
  // exactly once; whichever fires first wins, and the other becomes a no-op.
  const onResolved = (): void => finish('resolved');
  const onFailed = (): void => finish('failed');
  const onTimeout = (): void => finish('timed_out');

  const feed = (event: BrowserRuntimeEvent): void => {
    if (settledResult) return;
    controller.handleEvent(event);
    const nav = controller.getSnapshot().navigation;
    if (nav?.phase === 'readable') onResolved();
    else if (nav?.phase === 'failed') onFailed();
  };

  const generationChanged = (connectionGeneration: number, targetGeneration: number): void => {
    if (settledResult) return;
    controller.notifyGenerationAdvance(connectionGeneration, targetGeneration);
    const nav = controller.getSnapshot().navigation;
    if (nav?.phase === 'failed') onFailed();
  };

  const offEvents = options.source
    ? options.source.onRuntimeEvent(feed)
    : () => {};
  const offGenerations = options.source
    ? options.source.onGenerationChanged((change) => {
        generationChanged(change.connectionGeneration, change.targetGeneration);
      })
    : () => {};

  // Early check in case the controller was already terminal before subscribing.
  const nav = controller.getSnapshot().navigation;
  if (nav?.phase === 'readable') onResolved();
  else if (nav?.phase === 'failed') onFailed();

  // Wall-clock expiry: if the waiter hasn't settled yet, materialize the
  // timeout with diagnostics.
  void waiter.done.then((outcome) => {
    if (outcome.status === 'timed_out') {
      void outcome;
      settledResult = settledResult ?? materialize('timed_out');
    }
  });

  // Poll periodically so the settling window can elapse without new events.
  // Each poll calls `advanceSettling` which re-arms the baseline, but the
  // interval lets the clock advance between polls so the NETWORK/DOM quiet
  // window is satisfied.
  const pollInterval = setInterval(() => {
    if (settledResult) return;
    controller.pollReadiness(clock());
    const nav = controller.getSnapshot().navigation;
    if (nav?.phase === 'readable') finish('resolved');
    else if (nav?.phase === 'failed') finish('failed');
  }, 100);

  const finished = waiter.done.then((outcome): WaitForReadinessResult => {
    if (settledResult) return settledResult;
    return materialize(outcome.status === 'resolved' ? 'resolved' : 'timed_out');
  });

  const disposed = { value: false };
  const dispose = (): void => {
    if (disposed.value) return;
    disposed.value = true;
    clearInterval(pollInterval);
    offEvents();
    offGenerations();
  };

  return {
    finished,
    feed,
    generationChanged,
    dispose,
  };
}
