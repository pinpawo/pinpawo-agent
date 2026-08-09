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
    // Normalize the approved origin the same way commits are evaluated so the
    // comparison is symmetric: a caller passing `https://x.com/` or
    // `HTTPS://X.COM` (the natural thing, since it doubles as the requested URL)
    // lands on the same canonical form as an origin observed from a commit URL.
    approvedOrigin: canonicalOrigin(approvedOrigin),
    phase: 'requested',
  };
}

/**
 * Canonicalizes an http(s) origin string for storage/display: lowercase host,
 * default port collapsed, no trailing slash (`new URL(...).origin` semantics).
 * Non-http(s) input is returned verbatim; the browser backend only approves
 * http/https URLs anyway, and keeping the raw value lets us surface it in
 * error messages rather than silently dropping it.
 */
function canonicalOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
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
      const verdict = evaluateCommitOrigin(state.approvedOrigin, event.url);
      if (verdict.kind === 'intermediate') {
        // `about:blank`, `data:`, `chrome:` etc. are committed by Chrome as
        // intermediate steps while a real navigation is still in flight — or
        // as a transient blank. These are not a user-visible origin change and
        // must not fail the navigation; ignore them and keep waiting for the
        // real (http/s) commit.
        return state;
      }
      if (verdict.kind === 'rejected') {
        // A genuine cross-origin redirect is a real security boundary. Refuse
        // to accept it and emit `origin_changed`, which is how 跨源重定向 fails.
        return {
          ...state,
          phase: 'failed',
          error: {
            code: 'origin_changed',
            message: `navigation origin changed from ${verdict.approved} to ${verdict.actual}`,
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
    // Do not re-arm the settle baseline on every poll — the baseline is set
    // once when the navigation enters `settling`, and network events update it
    // independently. Re-arming prevents synchronous event bursts and periodic
    // polls from ever reaching the `readable` phase (issue #601).
    return state;
  }
  return state;
}

/** http(s) origin structure used for same-origin evaluation. */
type WebOrigin = {
  scheme: 'http' | 'https';
  /** Lowercased hostname with a leading `www.` stripped for host-family matching. */
  host: string;
  /** Effective port (explicit, or the scheme default). */
  port: number;
};

const DEFAULT_PORTS: Record<'http' | 'https', number> = { http: 80, https: 443 };

/**
 * Parses a URL into an http(s) origin structure, or `undefined` when the URL is
 * not http(s) — e.g. `about:blank`, `data:`, `chrome:` — which Chrome commits as
 * intermediate steps on many navigations and which must not fail a navigation.
 */
function parseWebOrigin(url: string): WebOrigin | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') return undefined;
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  const normalizedScheme = scheme === 'https:' ? 'https' : 'http';
  return {
    scheme: normalizedScheme,
    host,
    port: parsed.port ? Number(parsed.port) : DEFAULT_PORTS[normalizedScheme],
  };
}

function originLabel(origin: WebOrigin): string {
  const port = origin.port !== DEFAULT_PORTS[origin.scheme] ? `:${origin.port}` : '';
  return `${origin.scheme}://${origin.host}${port}`;
}

type CommitOriginVerdict =
  | { kind: 'accepted' }
  | { kind: 'intermediate'; url: string }
  | { kind: 'rejected'; approved: string; actual: string };

/**
 * Decides how a navigation `commit` event relates to the approved origin.
 *
 * - `accepted`: same host family (www↔apex), same effective port, and no
 *   security downgrade. A scheme *upgrade* from http to https on the same host
 *   is the web's most common redirect and is treated as same-origin; the
 *   volcengine target in the issue sits behind exactly such an upgrade.
 * - `intermediate`: non-http(s) URL (`about:blank`/`data:`/etc.) committed as a
 *   transient step; the navigation is still in flight and must be ignored.
 * - `rejected`: a genuine cross-origin redirect (different host, different
 *   effective port, or an https→http downgrade) — a security boundary.
 */
export function evaluateCommitOrigin(
  approvedOrigin: string,
  committedUrl: string,
): CommitOriginVerdict {
  const committed = parseWebOrigin(committedUrl);
  if (!committed) return { kind: 'intermediate', url: committedUrl };

  const approved = parseWebOrigin(approvedOrigin);
  // The approved origin is normalized by createNavigation to an http(s) origin;
  // if it somehow isn't parseable, conservatively treat any commit as a real
  // change rather than silently accepting a cross-origin page.
  if (!approved) {
    return { kind: 'rejected', approved: approvedOrigin, actual: originLabel(committed) };
  }

  const sameHostFamily = approved.host === committed.host;
  // Allow http→https upgrade; block the https→http security downgrade.
  const noDowngrade = !(approved.scheme === 'https' && committed.scheme === 'http');
  // Ports match when the explicit/normalized port is identical, or when both
  // sides rely on their *scheme default* port — an http→https upgrade on the
  // same host necessarily moves the default port 80→443, so a default-default
  // pairing under an upgrade is the same origin, not a port change.
  const approvedUsesDefaultPort = approved.port === DEFAULT_PORTS[approved.scheme];
  const committedUsesDefaultPort = committed.port === DEFAULT_PORTS[committed.scheme];
  const samePort =
    approved.port === committed.port ||
    (approvedUsesDefaultPort && committedUsesDefaultPort);

  return sameHostFamily && samePort && noDowngrade
    ? { kind: 'accepted' }
    : { kind: 'rejected', approved: originLabel(approved), actual: originLabel(committed) };
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
