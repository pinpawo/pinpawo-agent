import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTextAreaSelectAllSelection,
  getTextAreaSelectionRange,
  hasTextAreaSelection,
  normalizeTextAreaSelection,
} from './selection';

test('normalizeTextAreaSelection clamps offsets and drops collapsed ranges', () => {
  assert.deepEqual(
    normalizeTextAreaSelection({ anchorOffset: -5, focusOffset: 10 }, 'hello'),
    { anchorOffset: 0, focusOffset: 5 },
  );
  assert.equal(
    normalizeTextAreaSelection({ anchorOffset: 2, focusOffset: 2 }, 'hello'),
    undefined,
  );
  assert.equal(normalizeTextAreaSelection(null, 'hello'), undefined);
});

test('getTextAreaSelectionRange returns ordered selected range', () => {
  assert.deepEqual(
    getTextAreaSelectionRange({ anchorOffset: 4, focusOffset: 1 }, 'hello'),
    { start: 1, end: 4 },
  );
  assert.equal(getTextAreaSelectionRange({ anchorOffset: 2, focusOffset: 2 }, 'hello'), null);
});

test('hasTextAreaSelection and select-all handle empty and non-empty text', () => {
  assert.equal(hasTextAreaSelection({ anchorOffset: 0, focusOffset: 5 }, 'hello'), true);
  assert.equal(hasTextAreaSelection({ anchorOffset: 0, focusOffset: 0 }, 'hello'), false);
  assert.deepEqual(createTextAreaSelectAllSelection('hello'), {
    anchorOffset: 0,
    focusOffset: 5,
  });
  assert.equal(createTextAreaSelectAllSelection(''), undefined);
});
