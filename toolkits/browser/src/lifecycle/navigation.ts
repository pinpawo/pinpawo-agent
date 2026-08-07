/**
 * Browser Runtime navigation lifecycle.
 *
 * The Runtime owns navigation/action generations and drives the page through
 * explicit phases instead of handing a single "done or not" boolean to tools.
 * Old generations' late events are rejected so a stale page can never pollute
 * the current one.
 *
 * This is intentionally a pure state machine with no I/O: it can be unit-tested
 * in isolation and is wired to the extension/CDP event stream elsewhere.
 */

export const NAVIGATION_PHASES = [
  'requested',
  'committed',
  'dom_ready',
  'settling',
  'readable',
  'failed',
] as const;

export type NavigationPhase = typeof NAVIGATION_PHASES[number];

export type DocumentReadyState = 'loading' | 'interactive' | 'complete';

export type BrowserRuntimeError = {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

export type NavigationState = {
  generation: number;
  requestedUrl: string;
  committedUrl?: string;
  approvedOrigin: string;
  phase: NavigationPhase;
  readyState?: DocumentReadyState;
  /** Active network requests observed at the last sample. */
  inflightRequests?: number;
  /** Wall-clock ms (relative to a reference epoch) of the last network activity. */
  lastNetworkActivityAt?: number;
  /** Wall-clock ms (relative to a reference epoch) of the last DOM activity. */
  lastDomActivityAt?: number;
  textLength?: number;
  textRevision?: number;
  error?: BrowserRuntimeError;
};

export type ReadinessInput = {
  readyState?: DocumentReadyState;
  inflightRequests?: number;
  textLength?: number;
  textRevision?: number;
  lastNetworkActivityAt?: number;
  lastDomActivityAt?: number;
  now: number;
};

/**
 * The settling policy a navigation must pass before it is marked `readable`.
 */
export type PageReadinessPolicy = (input: ReadinessInput) => boolean;

export type NavigationApplyEvent =
  | { kind: 'commit'; url: string }
  | { kind: 'document.ready'; readyState: DocumentReadyState }
  | { kind: 'network'; inflightRequests: number; now: number }
  | {
      kind: 'dom';
      textLength: number;
      textRevision: number;
      now: number;
    }
  | { kind: 'settle_verdict'; readable: boolean; now: number }
  | { kind: 'fail'; error: BrowserRuntimeError };

/**
 * Creates a navigation-generation manager. `next()` advances the generation and
 * returns a fresh `Navigation` bound to it. Late events against a superseded
 * generation are rejected by the returned `apply` guard.
 */
export function createNavigationRegistry() {
  let generation = 0;

  const nextGeneration = (): number => {
    generation += 1;
    return generation;
  };

  return { nextGeneration };
}

export function createNavigation(
  generation: number,
  requestedUrl: string,
  approvedOrigin: string,
): NavigationState {
  return {
    generation,
    requestedUrl,
    approvedOrigin,
    phase: 'requested',
  };
}

/** An immutable-ish reducer that transitions the navigation state by event. */
export function applyNavigationEvent(
  state: NavigationState,
  event: NavigationApplyEvent,
  options: { readiness: PageReadinessPolicy } = { readiness: defaultPageReadinessPolicy },
): NavigationState {
  // `failed` is truly terminal: later events against a failed navigation are
  // ignored. `readable` is re-enterable — a new generation (e.g. an SPA
  // client-side route change) starts with a `commit`, which returns to the
  // committed phase and re-arms readiness tracking below.
  if (state.phase === 'failed') return state;
  if (state.phase === 'readable' && event.kind !== 'commit') return state;

  switch (event.kind) {
    case 'commit': {
      // A cross-origin redirect is a real security boundary: refuse to accept a
      // committed URL whose origin differs from the approved one. This is what
      // makes the reducer itself emit `origin_changed` for 跨源重定向.
      const approvedOrigin = state.approvedOrigin;
      if (originOf(event.url) !== approvedOrigin) {
        return {
          ...state,
          phase: 'failed',
          error: {
            code: 'origin_changed',
            message: `navigation origin changed from ${approvedOrigin} to ${originOf(event.url)}`,
            retryable: false,
            details: { requestedUrl: state.requestedUrl, committedUrl: event.url },
          },
        };
      }
      return {
        ...state,
        phase: 'committed',
        committedUrl: event.url,
        // Re-entering from `readable` (SPA route change) re-arms readiness
        // tracking for the newly committed document.
        readyState: undefined,
        inflightRequests: undefined,
        lastNetworkActivityAt: undefined,
        lastDomActivityAt: undefined,
        textLength: undefined,
        textRevision: undefined,
        error: undefined,
      };
    }
    case 'document.ready': {
      // The document reaching interactive/complete moves an in-flight
      // (requested/committed) navigation into the dom_ready phase. Later ready
      // events only refresh the readyState.
      if (state.phase === 'requested' || state.phase === 'committed') {
        return {
          ...state,
          phase: 'dom_ready',
          readyState: event.readyState,
        };
      }
      return { ...state, readyState: event.readyState };
    }
    case 'network':
      return {
        ...state,
        inflightRequests: event.inflightRequests,
        lastNetworkActivityAt:
          event.inflightRequests > 0 ? event.now : state.lastNetworkActivityAt,
      };
    case 'dom':
      return {
        ...state,
        textLength: event.textLength,
        textRevision: event.textRevision,
        // DOM churn (a ticking clock, carousel, polling widget) must not re-arm
        // the *network* settle window, or a page with recurring DOM revisions
        // could never quiet down. Track DOM activity on its own field.
        lastDomActivityAt: event.now,
      };
    case 'settle_verdict':
      return event.readable
        ? { ...state, phase: 'readable' }
        : advanceSettling(state, event.now);
    case 'fail':
      return { ...state, phase: 'failed', error: event.error };
  }
}

function advanceSettling(state: NavigationState, now: number): NavigationState {
  if (state.phase === 'dom_ready') {
    return { ...state, phase: 'settling', lastNetworkActivityAt: now };
  }
  if (state.phase === 'settling') {
    // Keep the settle baseline live: a false verdict means activity was still
    // being observed at `now`, so track it rather than freezing the window at
    // the first failed poll.
    return { ...state, lastNetworkActivityAt: now };
  }
  return state;
}

/** Extracts the `origin` (scheme + host + port) of a URL, or '' when invalid. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * Default combined readiness policy. A page is readable when the document is no
 * longer `loading`, there is a visible body worth reading, and network activity
 * has been quiet for the settling window. Long-lived connections (websocket/SSE)
 * that never report inflight requests do not block readiness forever.
 */
export function defaultPageReadinessPolicy(input: ReadinessInput): boolean {
  const { readyState, inflightRequests, textLength, textRevision, lastNetworkActivityAt, now } =
    input;

  if (!readyState || readyState === 'loading') return false;
  if (readyState === 'complete' || readyState === 'interactive') {
    // document reached interactive/complete but still has zero body text — keep waiting.
    if (typeof textLength === 'number' && textLength <= 0) return false;
  }
  if (typeof textRevision === 'number' && textRevision <= 0) return false;

  const inflight = inflightRequests ?? 0;
  if (inflight > 0) return false;

  // No text sample has been reported yet. A page whose shell is `complete` but
  // whose body text has not been sampled (volcengine scenario) is not readable —
  // wait for the body before declaring readiness.
  if (typeof textLength !== 'number') return false;

  // Network quietness only applies once we have a baseline activity sample.
  if (typeof lastNetworkActivityAt === 'number' && typeof textRevision === 'number') {
    if (now - lastNetworkActivityAt < SETTLING_WINDOW_MS) return false;
  }

  return true;
}

export const SETTLING_WINDOW_MS = 300;
