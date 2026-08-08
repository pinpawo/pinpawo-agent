/**
 * Compute page-readiness lifecycle events from a freshly captured snapshot.
 *
 * Issue #583: the extension/CDP driver reports raw page lifecycle facts and the
 * Runtime decides whether a navigation is "done" — the extension must not judge
 * readiness itself. When a snapshot is captured it already carries the DOM body
 * text and its length, so we derive the two events the Runtime's readiness state
 * machine needs to reach `readable`:
 *
 * - `document.ready`  → `readyState: 'complete'`  (a captured snapshot implies a
 *   finished/loaded document; the extension no longer needs `tab.status` polling
 *   to inform the Runtime of readiness)
 * - `dom.changed`      → `textLength` / `textRevision` from the sampled body.
 *   A positive text length confirms a visible body (the volcengine shell-only
 *   case), and a monotonic revision lets the Runtime key a stable reading.
 *
 * This module is deliberately a pure mapping: it takes a snapshot and returns
 * the event messages to post, so it can be unit-tested without any CDP or
 * chrome.* surface. The caller (background.ts) owns the actual `port.postMessage`.
 */
export type PageReadinessEventMessage = Readonly<{
  type: 'browser.event';
  event: 'document.ready' | 'dom.changed';
  tabId: number;
  url: string;
  payload: Readonly<Record<string, unknown>>;
}>;

const EMPTY_TEXT_LENGTH = 0;

/**
 * Derive the readiness events that follow a captured snapshot. Returns an empty
 * array when the snapshot carried no usable tab id or url (nothing to key the
 * events on).
 */
export function pageReadinessEvents(
  snapshot: Readonly<{ textLength?: unknown; url?: unknown; text?: unknown }>,
  tabId: number,
  url: string,
  revision = 1,
): PageReadinessEventMessage[] {
  if (!Number.isInteger(tabId) || tabId <= 0 || typeof url !== 'string' || !url) return [];

  const textLength =
    typeof snapshot.textLength === 'number'
      ? Math.max(snapshot.textLength, EMPTY_TEXT_LENGTH)
      : 0;
  const textRevision =
    typeof revision === 'number' && Number.isInteger(revision) && revision > 0 ? revision : 1;

  const readyRevision = Math.max(textRevision, 1);
  const changed: PageReadinessEventMessage = {
    type: 'browser.event',
    event: 'dom.changed',
    tabId,
    url,
    payload: Object.freeze({
      textLength,
      textRevision: readyRevision,
    }),
  };

  // If the body has no readable text yet (empty page, still hydrating), the
  // DOM is not stable enough to call readable. Only emit document.ready; the
  // Runtime's policy keeps waiting for text before it can reach readable.
  if (textLength <= 0) {
    return [
      {
        type: 'browser.event',
        event: 'document.ready',
        tabId,
        url,
        payload: Object.freeze({ readyState: 'complete' }),
      },
    ];
  }

  return [
    {
      type: 'browser.event',
      event: 'document.ready',
      tabId,
      url,
      payload: Object.freeze({ readyState: 'complete' }),
    },
    changed,
  ];
}
