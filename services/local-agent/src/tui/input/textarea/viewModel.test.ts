import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTextAreaViewModel } from './viewModel';

test('textarea view model renders focused text rows', () => {
  assert.deepEqual(
    buildTextAreaViewModel({
      text: 'abcdef',
      cursorOffset: 4,
      width: 3,
    }).rows,
    [
      { before: 'abc', cursor: null, after: '', dim: false, dimAfterCursor: false },
      { before: 'd', cursor: 'e', after: 'f', dim: false, dimAfterCursor: false },
    ],
  );
});

test('textarea view model includes selection render segments when selected', () => {
  assert.deepEqual(
    buildTextAreaViewModel({
      text: 'abcdef',
      cursorOffset: 6,
      selection: { anchorOffset: 1, focusOffset: 5 },
      width: 3,
    }).rows.map((row) => row.segments),
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

test('textarea view model renders focused placeholder cursor row', () => {
  assert.deepEqual(
    buildTextAreaViewModel({
      text: '',
      cursorOffset: 0,
      placeholder: '输入消息',
    }).rows,
    [
      {
        before: '',
        cursor: '输',
        after: '入消息',
        dim: false,
        dimAfterCursor: true,
      },
    ],
  );
});

test('textarea view model renders focused empty input as blank cursor row', () => {
  assert.deepEqual(
    buildTextAreaViewModel({
      text: '',
      cursorOffset: 0,
    }).rows,
    [
      {
        before: '',
        cursor: ' ',
        after: '',
        dim: false,
        dimAfterCursor: false,
      },
    ],
  );
});

test('textarea view model keeps placeholder cursor on grapheme boundaries', () => {
  assert.deepEqual(
    buildTextAreaViewModel({
      text: '',
      cursorOffset: 0,
      placeholder: '🙂 ok',
    }).rows,
    [
      {
        before: '',
        cursor: '🙂',
        after: ' ok',
        dim: false,
        dimAfterCursor: true,
      },
    ],
  );
});

test('textarea view model renders unfocused placeholder as dim wrapped rows', () => {
  assert.deepEqual(
    buildTextAreaViewModel({
      text: '',
      cursorOffset: 0,
      placeholder: 'abcdef',
      focused: false,
      width: 3,
    }).rows,
    [
      { before: 'abc', cursor: null, after: '', dim: true, dimAfterCursor: false },
      { before: 'def', cursor: null, after: '', dim: true, dimAfterCursor: false },
    ],
  );
});

test('textarea view model renders unfocused text as dim wrapped rows', () => {
  assert.deepEqual(
    buildTextAreaViewModel({
      text: 'abcdef',
      cursorOffset: 4,
      focused: false,
      width: 3,
    }).rows,
    [
      { before: 'abc', cursor: null, after: '', dim: true, dimAfterCursor: false },
      { before: 'def', cursor: null, after: '', dim: true, dimAfterCursor: false },
    ],
  );
});
