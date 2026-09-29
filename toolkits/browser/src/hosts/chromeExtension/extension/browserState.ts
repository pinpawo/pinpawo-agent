import type { BrowserTarget } from './types.js';

/** A context's current tab, and for a user-granted one the origin the grant approved. */
export type ContextTargetState = BrowserTarget & { userBoundOrigin?: string };

export function createBrowserStateTracker() {
  let revision = 0;

  return {
    advance() {
      revision += 1;
      return revision;
    },
    snapshot(
      activeTab: BrowserTarget | null,
      attachedTabId: number | null,
      userBoundOrigin: string | null = null,
      contexts: Record<string, ContextTargetState> = {},
    ) {
      return {
        revision,
        debuggerAttached: activeTab?.tabId === attachedTabId,
        ...(activeTab ? { activeTab: { ...activeTab } } : {}),
        ...(activeTab?.binding === 'user' && userBoundOrigin
          ? { userBoundOrigin }
          : {}),
        // Every session's current tab, so each reads its own user grant
        // instead of whichever context the extension activated last (#871).
        ...(Object.keys(contexts).length ? { contexts } : {}),
      };
    },
  };
}
