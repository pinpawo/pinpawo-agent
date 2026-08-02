function normalizeTarget(value) {
  if (!value || !Number.isInteger(value.tabId)) {
    throw new Error('browser target requires an integer tabId');
  }
  const binding = value.binding ?? value.ownership;
  if (binding !== 'agent' && binding !== 'user') {
    throw new Error('browser target binding must be agent or user');
  }
  return { tabId: value.tabId, binding };
}

export function createTargetStack(initialTarget = null, maxDepth = 16) {
  if (!Number.isInteger(maxDepth) || maxDepth <= 0) {
    throw new Error('browser target history depth must be a positive integer');
  }
  let current = initialTarget ? normalizeTarget(initialTarget) : null;
  let history = [];

  return {
    current() {
      return current ? { ...current } : null;
    },

    history() {
      return history.map((target) => ({ ...target }));
    },

    bind(nextTarget, options = {}) {
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

    remove(tabId) {
      history = history.filter((target) => target.tabId !== tabId);
      if (current?.tabId !== tabId) {
        return { closedCurrent: false, current: this.current() };
      }
      current = history.pop() ?? null;
      return { closedCurrent: true, current: this.current() };
    },
  };
}
