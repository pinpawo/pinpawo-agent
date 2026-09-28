/**
 * Element refs from the accessibility snapshot (issues #869 P1, #873).
 *
 * An accessibility ref names a CDP `backendNodeId`, which is only meaningful
 * inside one document. The ref therefore also carries a key of the main-frame
 * `loaderId` it was read from: Chromium issues a fresh, browser-wide unique
 * loader id for every document load, so a matching key means the same tab and
 * the same document. The key is the loader id's first 8 characters, which
 * keeps refs short in snapshots; a stale ref matching another load's key by
 * chance is a 1-in-2^32 event for a hex id.
 */

export type AccessibilityRef = Readonly<{
  loaderKey: string;
  backendNodeId: number;
  role: string;
}>;

const PREFIX = 'ax:';
const LOADER_KEY_LENGTH = 8;
const LOADER_ID = /^[A-Za-z0-9]{8,64}$/;
const REF = /^ax:([A-Za-z0-9]{8}):([1-9]\d*):([a-z]+)$/;

export function isAccessibilityRef(ref: string): boolean {
  return ref.startsWith(PREFIX);
}

/** The key a ref carries for a document load; null when the id is unusable. */
export function accessibilityLoaderKey(loaderId: string | null): string | null {
  if (!loaderId || !LOADER_ID.test(loaderId)) return null;
  return loaderId.slice(0, LOADER_KEY_LENGTH);
}

/** Null when the document is unknown: a bare node id could name another document's element. */
export function formatAccessibilityRef(
  loaderId: string | null,
  backendNodeId: unknown,
  role: string,
): string | null {
  const loaderKey = accessibilityLoaderKey(loaderId);
  if (!loaderKey) return null;
  if (!Number.isSafeInteger(backendNodeId) || (backendNodeId as number) <= 0) return null;
  if (!/^[a-z]+$/.test(role)) return null;
  return `${PREFIX}${loaderKey}:${backendNodeId}:${role}`;
}

/** A legacy or malformed ref yields null, so it is refused rather than reinterpreted. */
export function parseAccessibilityRef(ref: string): AccessibilityRef | null {
  const match = REF.exec(ref);
  if (!match) return null;
  const backendNodeId = Number(match[2]);
  if (!Number.isSafeInteger(backendNodeId)) return null;
  return { loaderKey: match[1], backendNodeId, role: match[3] };
}
