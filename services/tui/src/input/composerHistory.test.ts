import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_COMPOSER_HISTORY_ITEMS,
  createComposerHistoryState,
  navigateComposerHistory,
  recordComposerHistoryEntry,
  resetComposerHistoryNavigation,
  resolveComposerHistoryDirection,
} from './composerHistory';

test('composer history preserves exact multiline prompts and bounds entries', () => {
  let history = createComposerHistoryState();
  history = recordComposerHistoryEntry(history, '  code\n  block  ');
  assert.deepEqual(history.entries, ['  code\n  block  ']);
  history = recordComposerHistoryEntry(history, '  code\n  block  ');
  assert.equal(history.entries.length, 1);

  for (let index = 0; index <= MAX_COMPOSER_HISTORY_ITEMS; index += 1) {
    history = recordComposerHistoryEntry(history, `prompt ${index}`);
  }
  assert.equal(history.entries.length, MAX_COMPOSER_HISTORY_ITEMS);
  assert.equal(history.entries[0], 'prompt 1');
});

test('composer history navigates entries and restores the in-progress draft', () => {
  let history = recordComposerHistoryEntry(
    recordComposerHistoryEntry(createComposerHistoryState(), 'first'),
    'second\nline',
  );
  let result = navigateComposerHistory(history, 'draft', 'previous');
  history = result.history;
  assert.equal(result.value, 'second\nline');
  assert.equal(history.draft, 'draft');

  result = navigateComposerHistory(history, result.value, 'previous');
  history = result.history;
  assert.equal(result.value, 'first');

  result = navigateComposerHistory(history, result.value, 'next');
  history = result.history;
  assert.equal(result.value, 'second\nline');

  result = navigateComposerHistory(history, result.value, 'next');
  assert.equal(result.value, 'draft');
  assert.equal(result.history.selectedIndex, null);
});

test('composer history resets navigation without dropping recorded prompts', () => {
  const recorded = recordComposerHistoryEntry(
    createComposerHistoryState(),
    'prompt',
  );
  const navigating = navigateComposerHistory(recorded, 'draft', 'previous');
  assert.deepEqual(resetComposerHistoryNavigation(navigating.history), {
    entries: ['prompt'],
    selectedIndex: null,
    draft: '',
  });
});

test('composer history routes only plain arrows at visual boundaries', () => {
  const history = recordComposerHistoryEntry(
    createComposerHistoryState(),
    'prompt',
  );
  const editor = {
    hasSelection: () => false,
    scrollY: 0,
    editorView: {
      getTotalVirtualLineCount: () => 3,
    },
    visualCursor: { visualRow: 0 },
  };
  assert.equal(resolveComposerHistoryDirection(
    { name: 'up' },
    editor,
    history,
  ), 'previous');
  assert.equal(resolveComposerHistoryDirection(
    { name: 'up', shift: true },
    editor,
    history,
  ), null);
  assert.equal(resolveComposerHistoryDirection(
    { name: 'up' },
    { ...editor, hasSelection: () => true },
    history,
  ), null);
  assert.equal(resolveComposerHistoryDirection(
    { name: 'up' },
    { ...editor, visualCursor: { visualRow: 1 } },
    history,
  ), null);

  const navigating = navigateComposerHistory(history, 'draft', 'previous');
  assert.equal(resolveComposerHistoryDirection(
    { name: 'down' },
    { ...editor, visualCursor: { visualRow: 2 } },
    navigating.history,
  ), 'next');
});
