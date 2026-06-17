import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findTextAreaOffsetAtVisualColumn,
  findTextAreaRenderRowIndexForCursor,
  measureTextAreaLayout,
  measureTextAreaVisualColumn,
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

test('textarea layout reports cursor visual row boundaries', () => {
  assert.deepEqual(measureTextAreaLayout({ text: '', cursorOffset: 0 }, 3).cursor, {
    offset: 0,
    rowIndex: 0,
    column: 0,
    isAtFirstVisualRow: true,
    isAtLastVisualRow: true,
  });

  assert.deepEqual(measureTextAreaLayout({ text: 'abcdef', cursorOffset: 2 }, 3).cursor, {
    offset: 2,
    rowIndex: 0,
    column: 2,
    isAtFirstVisualRow: true,
    isAtLastVisualRow: false,
  });

  assert.deepEqual(measureTextAreaLayout({ text: 'abcdef', cursorOffset: 3 }, 3).cursor, {
    offset: 3,
    rowIndex: 1,
    column: 0,
    isAtFirstVisualRow: false,
    isAtLastVisualRow: true,
  });
});

test('textarea layout reports cursor visual columns with wide characters', () => {
  assert.deepEqual(measureTextAreaLayout({ text: '你a好b', cursorOffset: 3 }, 3).cursor, {
    offset: 3,
    rowIndex: 1,
    column: 2,
    isAtFirstVisualRow: false,
    isAtLastVisualRow: true,
  });
});

test('textarea layout wraps CJK text by terminal display width', () => {
  assert.deepEqual(
    wrapTextAreaRows('你好ab', 4),
    [
      { text: '你好', start: 0, end: 2 },
      { text: 'ab', start: 2, end: 4 },
    ],
  );
  assert.deepEqual(
    wrapTextAreaRows('你a好b', 3),
    [
      { text: '你a', start: 0, end: 2 },
      { text: '好b', start: 2, end: 4 },
    ],
  );
});

test('textarea layout keeps emoji graphemes intact while wrapping', () => {
  assert.deepEqual(
    wrapTextAreaRows('🙂a好', 3),
    [
      { text: '🙂a', start: 0, end: 3 },
      { text: '好', start: 3, end: 4 },
    ],
  );
  assert.deepEqual(
    wrapTextAreaRows('👨‍👩‍👧‍👦ab', 3),
    [
      { text: '👨‍👩‍👧‍👦a', start: 0, end: '👨‍👩‍👧‍👦a'.length },
      { text: 'b', start: '👨‍👩‍👧‍👦a'.length, end: '👨‍👩‍👧‍👦ab'.length },
    ],
  );
});

test('textarea layout renders cursor on full grapheme clusters', () => {
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

test('textarea layout maps cursor offsets and display columns across wide rows', () => {
  const text = '你a好b';
  const rows = wrapTextAreaRows(text, 3);

  assert.equal(measureTextAreaVisualColumn(rows[0]!, text, 0), 0);
  assert.equal(measureTextAreaVisualColumn(rows[0]!, text, 1), 2);
  assert.equal(measureTextAreaVisualColumn(rows[0]!, text, 2), 3);
  assert.equal(findTextAreaOffsetAtVisualColumn(rows[1]!, text, 0), 2);
  assert.equal(findTextAreaOffsetAtVisualColumn(rows[1]!, text, 1), 2);
  assert.equal(findTextAreaOffsetAtVisualColumn(rows[1]!, text, 2), 3);
  assert.equal(findTextAreaOffsetAtVisualColumn(rows[1]!, text, 3), 4);
});
