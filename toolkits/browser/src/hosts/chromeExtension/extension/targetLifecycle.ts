import type { BrowserTabLike, BrowserTarget, TargetBindOptions } from './types.js';

function normalizeTarget(value: unknown): BrowserTarget {
  const candidate = value as Record<string, unknown> | null;
  if (!candidate || !Number.isInteger(candidate.tabId)) {
    throw new Error('browser target requires an integer tabId');
  }
  const binding = candidate.binding ?? candidate.ownership;
  if (binding !== 'agent' && binding !== 'user') {
    throw new Error('browser target binding must be agent or user');
  }
  return { tabId: candidate.tabId as number, binding };
}

/**
 * browser_open must not repurpose a tab the user explicitly bound to PinPawo.
 * The caller creates an agent-owned tab for that case; an existing agent tab
 * may safely be reused for the next navigation.
 */
export function selectNavigationTarget(currentTarget: BrowserTarget | null) {
  if (!currentTarget) return 'create_agent_tab';
  return normalizeTarget(currentTarget).binding === 'agent'
    ? 'reuse_agent_tab'
    : 'create_agent_tab';
}

export function isWebTab(tab: BrowserTabLike | null | undefined) {
  const url = typeof tab?.url === 'string' ? tab.url : tab?.pendingUrl;
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Navigation settlement is independent from origin approval. The caller must
 * let its existing origin guard report a completed cross-origin redirect.
 */
export function isNavigableWebTab(tab: BrowserTabLike | null | undefined) {
  return tab?.status === 'complete' && isWebTab(tab);
}

/** A popup is relevant only while its initiating interaction is executing. */
export function shouldTrackPopup(
  activePopupParentTabId: number | null | undefined,
  currentTarget: BrowserTarget | null,
  openerTabId: number | null | undefined,
) {
  return Number.isInteger(activePopupParentTabId)
    && Number.isInteger(openerTabId)
    && activePopupParentTabId === openerTabId
    && currentTarget?.tabId === openerTabId;
}

export function createTargetStack(initialTarget: unknown = null, maxDepth = 16) {
  if (!Number.isInteger(maxDepth) || maxDepth <= 0) {
    throw new Error('browser target history depth must be a positive integer');
  }
  let current = initialTarget ? normalizeTarget(initialTarget) : null;
  let history: BrowserTarget[] = [];

  return {
    current() {
      return current ? { ...current } : null;
    },

    history() {
      return history.map((target) => ({ ...target }));
    },

    bind(nextTarget: unknown, options: TargetBindOptions = {}) {
      const next = nextTarget ? normalizeTarget(nextTarget) : null;
      if (options.resetHistory === true) history = [];
      if (
        options.rememberCurrent === true
        && current
        && current.tabId !== next?.tabId
      ) {
        history = history.filter((target) => target.tabId !== current.tabId);
        history.push(current);
        if (history.length > maxDepth) history = history.slice(-maxDepth);
      }
      if (next) {
        history = history.filter((target) => target.tabId !== next.tabId);
      }
      current = next;
      return this.current();
    },

    remove(tabId: number) {
      history = history.filter((target) => target.tabId !== tabId);
      if (current?.tabId !== tabId) {
        return { closedCurrent: false, current: this.current() };
      }
      current = history.pop() ?? null;
      return { closedCurrent: true, current: this.current() };
    },
  };
}
