import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyTextAreaControllerCommand,
  buildTextAreaComposerProps,
  buildTextAreaControllerState,
  measureTextAreaControllerLayout,
  resolveTextAreaHistoryBoundary,
} from './useTextAreaController';

test('buildTextAreaComposerProps builds textarea view model props', () => {
  assert.deepEqual(
    buildTextAreaComposerProps(
      { text: 'hello', cursorOffset: 2 },
      { focused: true, placeholder: '输入消息', width: 24 },
    ),
    {
      model: {
        rows: [
          {
            before: 'he',
            cursor: 'l',
            after: 'lo',
            dim: false,
            dimAfterCursor: false,
          },
        ],
      },
    },
  );
});

test('buildTextAreaComposerProps keeps focus and placeholder display in view model', () => {
  assert.deepEqual(
    buildTextAreaComposerProps(
      { text: '', cursorOffset: 0 },
      { focused: false, placeholder: 'abcdef', width: 3 },
    ),
    {
      model: {
        rows: [
          { before: 'abc', cursor: null, after: '', dim: true, dimAfterCursor: false },
          { before: 'def', cursor: null, after: '', dim: true, dimAfterCursor: false },
        ],
      },
    },
  );
});

test('buildTextAreaControllerState composes host state from textarea input', () => {
  assert.deepEqual(
    buildTextAreaControllerState(
      { text: 'abcdef', cursorOffset: 4 },
      { focused: true, placeholder: '输入消息', width: 3 },
    ),
    {
      value: 'abcdef',
      cursorOffset: 4,
      layout: {
        rows: [
          { text: 'abc', start: 0, end: 3 },
          { text: 'def', start: 3, end: 6 },
        ],
        cursor: {
          offset: 4,
          rowIndex: 1,
          column: 1,
          isAtFirstVisualRow: false,
          isAtLastVisualRow: true,
        },
      },
      cursor: {
        offset: 4,
        rowIndex: 1,
        column: 1,
        isAtFirstVisualRow: false,
        isAtLastVisualRow: true,
      },
      historyBoundary: {
        previous: false,
        next: true,
      },
      composerProps: {
        model: {
          rows: [
            { before: 'abc', cursor: null, after: '', dim: false, dimAfterCursor: false },
            { before: 'd', cursor: 'e', after: 'f', dim: false, dimAfterCursor: false },
          ],
        },
      },
    },
  );
});

test('resolveTextAreaHistoryBoundary follows visual cursor boundaries', () => {
  assert.deepEqual(
    resolveTextAreaHistoryBoundary(measureTextAreaControllerLayout({ text: 'abc', cursorOffset: 1 }, 10)),
    { previous: true, next: true },
  );
  assert.deepEqual(
    resolveTextAreaHistoryBoundary(measureTextAreaControllerLayout({ text: 'abcdef', cursorOffset: 1 }, 3)),
    { previous: true, next: false },
  );
  assert.deepEqual(
    resolveTextAreaHistoryBoundary(measureTextAreaControllerLayout({ text: 'abcdef', cursorOffset: 4 }, 3)),
    { previous: false, next: true },
  );
});

test('applyTextAreaControllerCommand applies textarea command with host width', () => {
  assert.deepEqual(
    applyTextAreaControllerCommand(
      { text: 'abcdef', cursorOffset: 1 },
      { type: 'moveDown' },
      3,
    ),
    { text: 'abcdef', cursorOffset: 4 },
  );
  assert.deepEqual(
    applyTextAreaControllerCommand(
      { text: 'hello', cursorOffset: 5, selection: { anchorOffset: 1, focusOffset: 4 } },
      { type: 'insert', text: 'i' },
      10,
    ),
    { text: 'hio', cursorOffset: 2 },
  );
});

test('measureTextAreaControllerLayout exposes visual cursor boundaries', () => {
  assert.deepEqual(
    measureTextAreaControllerLayout({ text: 'abcdef', cursorOffset: 1 }, 3).cursor,
    {
      offset: 1,
      rowIndex: 0,
      column: 1,
      isAtFirstVisualRow: true,
      isAtLastVisualRow: false,
    },
  );
  assert.deepEqual(
    measureTextAreaControllerLayout({ text: 'abcdef', cursorOffset: 4 }, 3).cursor,
    {
      offset: 4,
      rowIndex: 1,
      column: 1,
      isAtFirstVisualRow: false,
      isAtLastVisualRow: true,
    },
  );
});
