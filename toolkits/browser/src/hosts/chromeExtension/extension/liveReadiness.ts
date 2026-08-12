/**
 * Translate raw CDP page/network/tab facts into the unified `BrowserRuntimeEvent`
 * readiness stream that the Runtime's lifecycle state machine consumes.
 *
 * Issue #583 / #601: the *extension* must report raw page lifecycle facts and the
 * Runtime decides readiness — `tab.status === 'complete'` alone is not enough
 * (the volcengine shell-only case keeps firing inflight requests after load, and
 * an SPA may need repeated DOM text samples). This module is the pure, I/O-free
 * counterpart of `pageReadiness.ts` for a **live** CDP stream: it maps raw CDP
 * event facts into the events the reducer needs to reach `readable`.
 *
 * It does **not** own any `chrome.debugger` / `chrome.tabs` I/O. It is a pure
 * data transformation (testable in isolation, like `pageReadiness.ts`); the
 * caller (`background.ts`) owns the `chrome.debugger.onEvent` /
 * `chrome.tabs.onUpdated` subscriptions and the `port.postMessage`.
 *
 * The produced event types are the ones `BrowserLifecycleController` folds into
 * `navigation.committed` / `document.ready` / `network.activity` / `dom.changed`
 * (see `controller.toApplyEvent`).
 */

export type LiveReadinessEventMessage = Readonly<{
  type: 'browser.event';
  event:
    | 'navigation.committed'
    | 'document.ready'
    | 'network.activity'
    | 'dom.changed';
  tabId: number;
  url?: string;
  payload: Readonly<Record<string, unknown>>;
}>;

/** Which live CDP domain the extension must `Page.enable`/`Network.enable` to
 *  observe. Exposed so a review can confirm the allowlist covers them. */
export const LIVE_READINESS_CDP_ENABLES = ['Page', 'Network'] as const;

/**
 * A raw CDP `Network.requestWillBeSent` / `Network.loadingFinished` /
 * `Network.loadingFailed` fact collapsed to a signed inflight delta.
 */
export type NetworkActivityFact = {
  kind: 'request' | 'finish' | 'fail';
  timestamp: number;
};

/** Translate one network activity fact into a `network.activity` event. */
export function networkActivityEvent(
  fact: NetworkActivityFact,
  tabId: number,
  baseInflight = 0,
): LiveReadinessEventMessage {
  const delta = fact.kind === 'request' ? 1 : -1;
  return {
    type: 'browser.event',
    event: 'network.activity',
    tabId,
    payload: {
      inflightRequests: Math.max(0, baseInflight + delta),
    },
  };
}

/** A raw `Page.loadEventFired` / `document readyState` observation. */
export type DocumentReadyFact = {
  readyState: 'loading' | 'interactive' | 'complete';
  timestamp: number;
};

/** Translate a document readyState observation into a `document.ready` event. */
export function documentReadyEvent(
  fact: DocumentReadyFact,
  tabId: number,
  url: string,
): LiveReadinessEventMessage {
  return {
    type: 'browser.event',
    event: 'document.ready',
    tabId,
    url,
    payload: { readyState: fact.readyState },
  };
}

/** A sampled body text observation (CDP `Runtime.evaluate` of body.innerText). */
export type DomSampleFact = {
  textLength: number;
  textRevision: number;
  timestamp: number;
};

/** Translate a body-text sample into a `dom.changed` event. */
export function domChangedEvent(
  fact: DomSampleFact,
  tabId: number,
  url: string,
): LiveReadinessEventMessage {
  return {
    type: 'browser.event',
    event: 'dom.changed',
    tabId,
    url,
    payload: {
      textLength: Math.max(0, fact.textLength),
      textRevision: Math.max(1, Math.floor(fact.textRevision)),
    },
  };
}

/** A navigation commit observation (CDP `Page.frameNavigated` / commit URL). */
export type CommitFact = {
  url: string;
  timestamp: number;
};

/** Translate a navigation commit into a `navigation.committed` event. */
export function navigationCommittedEvent(
  fact: CommitFact,
  tabId: number,
): LiveReadinessEventMessage {
  return {
    type: 'browser.event',
    event: 'navigation.committed',
    tabId,
    url: fact.url,
    payload: {},
  };
}

/**
 * Build the readiness event burst a freshly-observed live navigation should
 * emit, in the order the reducer expects (commit first, then ready, then the
 * first DOM sample). This is the live-stream analog of `pageReadinessEvents`
 * for a snapshot.
 */
export function liveReadinessBurst(
  input: {
    tabId: number;
    url: string;
    committed?: boolean;
    readyState?: DocumentReadyFact['readyState'];
    textLength?: number;
    textRevision?: number;
    inflight?: number;
  },
): LiveReadinessEventMessage[] {
  const { tabId, url } = input;
  if (!Number.isInteger(tabId) || tabId <= 0 || typeof url !== 'string' || !url) return [];
  const events: LiveReadinessEventMessage[] = [];
  if (input.committed !== false) {
    events.push(navigationCommittedEvent({ url, timestamp: 0 }, tabId));
  }
  if (input.readyState) {
    events.push(
      documentReadyEvent({ readyState: input.readyState, timestamp: 0 }, tabId, url),
    );
  }
  if (typeof input.inflight === 'number' && input.inflight > 0) {
    events.push(
      networkActivityEvent({ kind: 'request', timestamp: 0 }, tabId, input.inflight - 1),
    );
  }
  if (typeof input.textLength === 'number') {
    events.push(
      domChangedEvent(
        { textLength: input.textLength, textRevision: input.textRevision ?? 1, timestamp: 0 },
        tabId,
        url,
      ),
    );
  }
  return events;
}
