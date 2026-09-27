/**
 * Element refs from the accessibility snapshot fallback (issue #869, P1).
 *
 * A DOM snapshot ref resolves through a registry that lives in the page and is
 * replaced by every snapshot, so it cannot reach another tab or document. An
 * accessibility ref instead names a CDP `backendNodeId`, which is only
 * meaningful inside one document. The ref therefore also carries the
 * main-frame `loaderId` it was read from: Chromium issues a fresh, browser-wide
 * unique loader id for every document load, so a matching loader id means the
 * same tab and the same document.
 */

export type AccessibilityRef = Readonly<{
  loaderId: string;
  backendNodeId: number;
  role: string;
}>;

const PREFIX = 'ax:';
const LOADER_ID = /^[A-Za-z0-9]{1,64}$/;
const REF = /^ax:([A-Za-z0-9]{1,64}):([1-9]\d*):([a-z]+)$/;

export function isAccessibilityRef(ref: string): boolean {
  return ref.startsWith(PREFIX);
}

/** Null when the document is unknown: a bare node id could name another document's element. */
export function formatAccessibilityRef(
  loaderId: string | null,
  backendNodeId: unknown,
  role: string,
): string | null {
  if (!loaderId || !LOADER_ID.test(loaderId)) return null;
  if (!Number.isSafeInteger(backendNodeId) || (backendNodeId as number) <= 0) return null;
  if (!/^[a-z]+$/.test(role)) return null;
  return `${PREFIX}${loaderId}:${backendNodeId}:${role}`;
}

/** A legacy or malformed ref yields null, so it is refused rather than reinterpreted. */
export function parseAccessibilityRef(ref: string): AccessibilityRef | null {
  const match = REF.exec(ref);
  if (!match) return null;
  const backendNodeId = Number(match[2]);
  if (!Number.isSafeInteger(backendNodeId)) return null;
  return { loaderId: match[1], backendNodeId, role: match[3] };
}
