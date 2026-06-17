import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findTextAreaRenderRowIndexForCursor,
  renderTextAreaRows,
  wrapTextAreaRows,
} from './layout';

test('textarea layout wraps logical lines into terminal rows', () => {
  assert.deepEqual(
    wrapTextAreaRows('abcdef\nghij', 3),
    [
      { text: 'abc', start: 0, end: 3 },
      { text: 'def', start: 3, end: 6 },
      { text: 'ghi', start: 7, end: 10 },
      { text: 'j', start: 10, end: 11 },
    ],
  );
});

test('textarea layout renders cursor within wrapped content', () => {
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

test('textarea layout locates cursor rows at soft-wrap and newline boundaries', () => {
  const rows = wrapTextAreaRows('abcdef\ngh', 3);

  assert.equal(findTextAreaRenderRowIndexForCursor(rows, 'abcdef\ngh', 0), 0);
  assert.equal(findTextAreaRenderRowIndexForCursor(rows, 'abcdef\ngh', 3), 1);
  assert.equal(findTextAreaRenderRowIndexForCursor(rows, 'abcdef\ngh', 6), 1);
  assert.equal(findTextAreaRenderRowIndexForCursor(rows, 'abcdef\ngh', 7), 2);
});
