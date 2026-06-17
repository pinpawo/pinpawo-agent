import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyTextAreaCommand,
  applyTextAreaInput,
  applyTextAreaInputEvent,
  createTextAreaModel,
} from './engine';

test('textarea engine applies textarea edit commands', () => {
  let state = createTextAreaModel('helo', 2);
  state = applyTextAreaCommand({ type: 'insert', text: 'l' }, state);
  assert.deepEqual(state, { text: 'hello', cursorOffset: 3 });

  state = applyTextAreaCommand({ type: 'moveLeft' }, state);
  assert.deepEqual(state, { text: 'hello', cursorOffset: 2 });

  state = applyTextAreaCommand({ type: 'deleteBackward' }, state);
  assert.deepEqual(state, { text: 'hllo', cursorOffset: 1 });
});

test('textarea engine handles line and word editing commands', () => {
  assert.deepEqual(
    applyTextAreaCommand(
      { type: 'deleteWordBackward' },
      { text: 'run shell command', cursorOffset: 'run shell'.length },
    ),
    { text: 'run  command', cursorOffset: 4 },
  );
  assert.deepEqual(
    applyTextAreaCommand(
      { type: 'deleteToLineStart' },
      { text: 'one\ntwo three', cursorOffset: 8 },
    ),
    { text: 'one\nthree', cursorOffset: 4 },
  );
  assert.deepEqual(
    applyTextAreaCommand(
      { type: 'deleteToLineEnd' },
      { text: 'one\ntwo three', cursorOffset: 8 },
    ),
    { text: 'one\ntwo ', cursorOffset: 8 },
  );
});

test('textarea engine uses layout rows for vertical cursor movement', () => {
  const text = 'abcdef\ngh';

  assert.deepEqual(
    applyTextAreaCommand({ type: 'moveUp' }, { text, cursorOffset: 4 }, { width: 3 }),
    { text, cursorOffset: 1 },
  );
  assert.deepEqual(
    applyTextAreaCommand({ type: 'moveDown' }, { text, cursorOffset: 5 }, { width: 3 }),
    { text, cursorOffset: 9 },
  );
});

test('textarea engine preserves visual column across wide character rows', () => {
  const text = '你a好b';

  assert.deepEqual(
    applyTextAreaCommand({ type: 'moveDown' }, { text, cursorOffset: 1 }, { width: 3 }),
    { text, cursorOffset: 3 },
  );
  assert.deepEqual(
    applyTextAreaCommand({ type: 'moveUp' }, { text, cursorOffset: 3 }, { width: 3 }),
    { text, cursorOffset: 1 },
  );
});

test('textarea engine keeps canonical event wrapper compatibility', () => {
  assert.deepEqual(
    applyTextAreaInputEvent({ type: 'text.insert', text: 'x' }, { text: '', cursorOffset: 0 }),
    { text: 'x', cursorOffset: 1 },
  );
  assert.deepEqual(
    applyTextAreaInputEvent({ type: 'submit' }, { text: 'x', cursorOffset: 1 }),
    { text: 'x', cursorOffset: 1 },
  );
});

test('textarea engine keeps raw input wrapper compatibility', () => {
  assert.deepEqual(
    applyTextAreaInput('\x1b[3~', {}, { text: 'abc', cursorOffset: 1 }),
    { text: 'ac', cursorOffset: 1 },
  );
});
