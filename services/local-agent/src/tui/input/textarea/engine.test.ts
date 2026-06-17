import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyTextAreaInput,
  applyTextAreaInputEvent,
  createTextAreaModel,
} from './engine';

test('textarea engine applies canonical text edit events', () => {
  let state = createTextAreaModel('helo', 2);
  state = applyTextAreaInputEvent({ type: 'text.insert', text: 'l' }, state);
  assert.deepEqual(state, { text: 'hello', cursorOffset: 3 });

  state = applyTextAreaInputEvent({ type: 'cursor.left' }, state);
  assert.deepEqual(state, { text: 'hello', cursorOffset: 2 });

  state = applyTextAreaInputEvent({ type: 'text.delete.backward' }, state);
  assert.deepEqual(state, { text: 'hllo', cursorOffset: 1 });
});

test('textarea engine handles line and word editing events', () => {
  assert.deepEqual(
    applyTextAreaInputEvent(
      { type: 'text.delete.word.backward' },
      { text: 'run shell command', cursorOffset: 'run shell'.length },
    ),
    { text: 'run  command', cursorOffset: 4 },
  );
  assert.deepEqual(
    applyTextAreaInputEvent(
      { type: 'text.delete.to.line.start' },
      { text: 'one\ntwo three', cursorOffset: 8 },
    ),
    { text: 'one\nthree', cursorOffset: 4 },
  );
  assert.deepEqual(
    applyTextAreaInputEvent(
      { type: 'text.delete.to.line.end' },
      { text: 'one\ntwo three', cursorOffset: 8 },
    ),
    { text: 'one\ntwo ', cursorOffset: 8 },
  );
});

test('textarea engine uses layout rows for vertical cursor movement', () => {
  const text = 'abcdef\ngh';

  assert.deepEqual(
    applyTextAreaInputEvent({ type: 'cursor.up' }, { text, cursorOffset: 4 }, { width: 3 }),
    { text, cursorOffset: 1 },
  );
  assert.deepEqual(
    applyTextAreaInputEvent({ type: 'cursor.down' }, { text, cursorOffset: 5 }, { width: 3 }),
    { text, cursorOffset: 9 },
  );
});

test('textarea engine preserves visual column across wide character rows', () => {
  const text = '你a好b';

  assert.deepEqual(
    applyTextAreaInputEvent({ type: 'cursor.down' }, { text, cursorOffset: 1 }, { width: 3 }),
    { text, cursorOffset: 3 },
  );
  assert.deepEqual(
    applyTextAreaInputEvent({ type: 'cursor.up' }, { text, cursorOffset: 3 }, { width: 3 }),
    { text, cursorOffset: 1 },
  );
});

test('textarea engine keeps raw input wrapper compatibility', () => {
  assert.deepEqual(
    applyTextAreaInput('\x1b[3~', {}, { text: 'abc', cursorOffset: 1 }),
    { text: 'ac', cursorOffset: 1 },
  );
});
