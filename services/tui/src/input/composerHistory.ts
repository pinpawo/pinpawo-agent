export const MAX_COMPOSER_HISTORY_ITEMS = 100;

export type ComposerHistoryDirection = 'previous' | 'next';

export type ComposerHistoryState = {
  entries: string[];
  selectedIndex: number | null;
  draft: string;
};

export type ComposerHistoryEditor = {
  hasSelection: () => boolean;
  scrollY: number;
  editorView: {
    getTotalVirtualLineCount: () => number;
  };
  visualCursor: {
    visualRow: number;
  };
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
  if (!value.trim()) return resetComposerHistoryNavigation(history);
  const entries = history.entries.at(-1) === value
    ? history.entries
    : [...history.entries, value].slice(-MAX_COMPOSER_HISTORY_ITEMS);
  return {
    entries,
    selectedIndex: null,
    draft: '',
  };
}

export function resetComposerHistoryNavigation(
  history: ComposerHistoryState,
): ComposerHistoryState {
  if (history.selectedIndex === null && history.draft === '') return history;
  return {
    ...history,
    selectedIndex: null,
    draft: '',
  };
}

export function navigateComposerHistory(
  history: ComposerHistoryState,
  currentValue: string,
  direction: ComposerHistoryDirection,
) {
  if (direction === 'previous') {
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

export function resolveComposerHistoryDirection(
  key: {
    name?: string;
    ctrl?: boolean;
    shift?: boolean;
    meta?: boolean;
    option?: boolean;
    super?: boolean;
  },
  editor: ComposerHistoryEditor,
  history: ComposerHistoryState,
): ComposerHistoryDirection | null {
  if (
    editor.hasSelection()
    || key.ctrl
    || key.shift
    || key.meta
    || key.option
    || key.super
  ) {
    return null;
  }
  const visualRow = editor.scrollY + editor.visualCursor.visualRow;
  if (
    key.name === 'up'
    && visualRow === 0
    && (history.selectedIndex === null
      ? history.entries.length > 0
      : history.selectedIndex > 0)
  ) {
    return 'previous';
  }
  if (
    key.name === 'down'
    && visualRow >= Math.max(
      0,
      editor.editorView.getTotalVirtualLineCount() - 1,
    )
    && history.selectedIndex !== null
  ) {
    return 'next';
  }
  return null;
}
