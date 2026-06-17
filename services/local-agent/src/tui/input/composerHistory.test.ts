import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createComposerHistoryState,
  getComposerHistoryAvailability,
  MAX_COMPOSER_HISTORY_ITEMS,
  navigateComposerHistory,
  recordComposerHistoryEntry,
  resetComposerHistoryNavigation,
} from './composerHistory';

test('recordComposerHistoryEntry stores trimmed prompts and dedupes consecutive entries', () => {
  let history = createComposerHistoryState();

  history = recordComposerHistoryEntry(history, '  hello  ');
  history = recordComposerHistoryEntry(history, 'hello');
  history = recordComposerHistoryEntry(history, 'world');
  history = recordComposerHistoryEntry(history, '   ');

  assert.deepEqual(history.entries, ['hello', 'world']);
  assert.equal(history.selectedIndex, null);
  assert.equal(history.draft, '');
});

test('recordComposerHistoryEntry bounds prompt history length', () => {
  let history = createComposerHistoryState();
  for (let index = 0; index < MAX_COMPOSER_HISTORY_ITEMS + 2; index += 1) {
    history = recordComposerHistoryEntry(history, `prompt ${index}`);
  }

  assert.equal(history.entries.length, MAX_COMPOSER_HISTORY_ITEMS);
  assert.equal(history.entries[0], 'prompt 2');
  assert.equal(history.entries.at(-1), `prompt ${MAX_COMPOSER_HISTORY_ITEMS + 1}`);
});

test('navigateComposerHistory moves through entries and restores draft', () => {
  let history = createComposerHistoryState();
  history = recordComposerHistoryEntry(history, 'first');
  history = recordComposerHistoryEntry(history, 'second');

  let result = navigateComposerHistory(history, 'draft text', 'previous');
  assert.equal(result.value, 'second');
  assert.deepEqual(getComposerHistoryAvailability(result.history), {
    previous: true,
    next: true,
  });

  result = navigateComposerHistory(result.history, result.value, 'previous');
  assert.equal(result.value, 'first');
  assert.deepEqual(getComposerHistoryAvailability(result.history), {
    previous: false,
    next: true,
  });

  result = navigateComposerHistory(result.history, result.value, 'next');
  assert.equal(result.value, 'second');

  result = navigateComposerHistory(result.history, result.value, 'next');
  assert.equal(result.value, 'draft text');
  assert.deepEqual(result.history, {
    entries: ['first', 'second'],
    selectedIndex: null,
    draft: '',
  });
});

test('resetComposerHistoryNavigation clears active selection without removing entries', () => {
  let history = createComposerHistoryState();
  history = recordComposerHistoryEntry(history, 'hello');
  history = navigateComposerHistory(history, 'draft', 'previous').history;

  assert.deepEqual(resetComposerHistoryNavigation(history), {
    entries: ['hello'],
    selectedIndex: null,
    draft: '',
  });
});
