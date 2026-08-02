export function createBrowserStateTracker() {
  let revision = 0;

  return {
    advance() {
      revision += 1;
      return revision;
    },
    snapshot(activeTab, attachedTabId, userBoundOrigin = null) {
      return {
        revision,
        debuggerAttached: activeTab?.tabId === attachedTabId,
        ...(activeTab ? { activeTab: { ...activeTab } } : {}),
        ...(activeTab?.binding === 'user' && userBoundOrigin
          ? { userBoundOrigin }
          : {}),
      };
    },
  };
}
