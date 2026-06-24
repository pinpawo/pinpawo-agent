import assert from 'node:assert/strict';
import test from 'node:test';
import { renderTextAreaRows } from './renderModel';

test('textarea render model renders cursor within wrapped content', () => {
  assert.deepEqual(
    renderTextAreaRows({ text: 'abcdef\nghij', cursorOffset: 4 }, 3).map((row) => ({
      before: row.before,
      cursor: row.cursor,
      after: row.after,
    })),
    [
      { before: 'abc', cursor: null, after: '' },
      { before: 'd', cursor: 'e', after: 'f' },
      { before: 'ghi', cursor: null, after: '' },
      { before: 'j', cursor: null, after: '' },
    ],
  );
});

test('textarea render model renders cursor on full grapheme clusters', () => {
  assert.deepEqual(
    renderTextAreaRows({ text: '🙂a', cursorOffset: 0 }, 3).map((row) => ({
      before: row.before,
      cursor: row.cursor,
      after: row.after,
    })),
    [{ before: '', cursor: '🙂', after: 'a' }],
  );
  assert.deepEqual(
    renderTextAreaRows({ text: '🙂a', cursorOffset: 1 }, 3).map((row) => ({
      before: row.before,
      cursor: row.cursor,
      after: row.after,
    })),
    [{ before: '', cursor: '🙂', after: 'a' }],
  );
  assert.deepEqual(
    renderTextAreaRows({ text: '🙂a', cursorOffset: 2 }, 3).map((row) => ({
      before: row.before,
      cursor: row.cursor,
      after: row.after,
    })),
    [{ before: '🙂', cursor: 'a', after: '' }],
  );
});

test('textarea render model marks selected grapheme segments', () => {
  assert.deepEqual(
    renderTextAreaRows({
      text: 'abcdef',
      cursorOffset: 6,
      selection: { anchorOffset: 1, focusOffset: 5 },
    }, 3).map((row) => row.segments),
    [
      [
        { text: 'a', selected: false, cursor: false },
        { text: 'b', selected: true, cursor: false },
        { text: 'c', selected: true, cursor: false },
      ],
      [
        { text: 'd', selected: true, cursor: false },
        { text: 'e', selected: true, cursor: false },
        { text: 'f', selected: false, cursor: false },
        { text: ' ', selected: false, cursor: true },
      ],
    ],
  );
});

test('textarea render model keeps selection on grapheme boundaries', () => {
  assert.deepEqual(
    renderTextAreaRows({
      text: '🙂a',
      cursorOffset: 2,
      selection: { anchorOffset: 0, focusOffset: 2 },
    }, 3).map((row) => row.segments),
    [[
      { text: '🙂', selected: true, cursor: false },
      { text: 'a', selected: false, cursor: true },
    ]],
  );
});
