export const MAX_COMPOSER_HISTORY_ITEMS = 100;

export type ComposerHistoryDirection = 'previous' | 'next';

export type ComposerHistoryState = {
  entries: string[];
  selectedIndex: number | null;
  draft: string;
};

export type ComposerHistoryAvailability = Record<ComposerHistoryDirection, boolean>;

export type ComposerHistoryNavigationResult = {
  history: ComposerHistoryState;
  value: string;
};

export function createComposerHistoryState(): ComposerHistoryState {
  return {
    entries: [],
    selectedIndex: null,
    draft: '',
  };
}

export function recordComposerHistoryEntry(
  history: ComposerHistoryState,
  value: string,
): ComposerHistoryState {
  const entry = value.trim();
  if (!entry) return resetComposerHistoryNavigation(history);

  const entries = history.entries.at(-1) === entry
    ? history.entries
    : [...history.entries, entry].slice(-MAX_COMPOSER_HISTORY_ITEMS);

  return {
    entries,
    selectedIndex: null,
    draft: '',
  };
}

export function resetComposerHistoryNavigation(history: ComposerHistoryState): ComposerHistoryState {
  if (history.selectedIndex === null && history.draft === '') return history;
  return {
    ...history,
    selectedIndex: null,
    draft: '',
  };
}

export function getComposerHistoryAvailability(history: ComposerHistoryState): ComposerHistoryAvailability {
  return {
    previous: history.selectedIndex === null
      ? history.entries.length > 0
      : history.selectedIndex > 0,
    next: history.selectedIndex !== null,
  };
}

export function navigateComposerHistory(
  history: ComposerHistoryState,
  currentValue: string,
  direction: ComposerHistoryDirection,
): ComposerHistoryNavigationResult {
  if (direction === 'previous') {
    return navigateComposerHistoryPrevious(history, currentValue);
  }
  return navigateComposerHistoryNext(history, currentValue);
}

function navigateComposerHistoryPrevious(
  history: ComposerHistoryState,
  currentValue: string,
): ComposerHistoryNavigationResult {
  if (history.entries.length === 0) {
    return { history, value: currentValue };
  }

  const selectedIndex = history.selectedIndex === null
    ? history.entries.length - 1
    : Math.max(0, history.selectedIndex - 1);

  return {
    history: {
      ...history,
      selectedIndex,
      draft: history.selectedIndex === null ? currentValue : history.draft,
    },
    value: history.entries[selectedIndex] ?? currentValue,
  };
}

function navigateComposerHistoryNext(
  history: ComposerHistoryState,
  currentValue: string,
): ComposerHistoryNavigationResult {
  if (history.selectedIndex === null) {
    return { history, value: currentValue };
  }

  const selectedIndex = history.selectedIndex + 1;
  if (selectedIndex >= history.entries.length) {
    return {
      history: {
        ...history,
        selectedIndex: null,
        draft: '',
      },
      value: history.draft,
    };
  }

  return {
    history: {
      ...history,
      selectedIndex,
    },
    value: history.entries[selectedIndex] ?? currentValue,
  };
}
