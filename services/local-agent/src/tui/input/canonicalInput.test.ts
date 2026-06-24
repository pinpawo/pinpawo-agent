import assert from 'node:assert/strict';
import test from 'node:test';
import { toCanonicalInputEvent } from './canonicalInput';

test('toCanonicalInputEvent maps text input and paste text to semantic events', () => {
  assert.deepEqual(
    toCanonicalInputEvent({ input: 'hello', key: {} }),
    { type: 'text.insert', text: 'hello' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: 'a\r\nb\rc', key: {} }),
    { type: 'text.insert', text: 'a\nb\nc' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: '\x1b[200~a\r\nb\x1b[201~', key: {} }),
    { type: 'text.paste', text: 'a\nb' },
  );
});

test('toCanonicalInputEvent maps submit and newline variants', () => {
  assert.deepEqual(
    toCanonicalInputEvent({ input: '', key: { return: true } }),
    { type: 'submit' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: '\r\n', key: {} }),
    { type: 'submit' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: '', key: { return: true, shift: true } }),
    { type: 'newline' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: '[27;2;13~', key: {} }),
    { type: 'newline' },
  );
});

test('toCanonicalInputEvent maps edit and cursor keys', () => {
  assert.deepEqual(
    toCanonicalInputEvent({ input: '\x7f', key: {} }),
    { type: 'text.delete.backward' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: '\b', key: {} }),
    { type: 'text.delete.backward' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: '', key: { backspace: true } }),
    { type: 'text.delete.backward' },
  );
  // Ink reports the Backspace key as `key.delete` with empty input, so a bare
  // `key.delete` must map to backward delete (the common case).
  assert.deepEqual(
    toCanonicalInputEvent({ input: '', key: { delete: true } }),
    { type: 'text.delete.backward' },
  );
  // The forward-delete key arrives as a raw \x1b[3~ sequence and stays forward,
  // even if Ink also flags it as `key.delete`.
  assert.deepEqual(
    toCanonicalInputEvent({ input: '\x1b[3~', key: {} }),
    { type: 'text.delete.forward' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: '\x1b[3~', key: { delete: true } }),
    { type: 'text.delete.forward' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: '[3;5~', key: {} }),
    { type: 'text.delete.forward' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: '', key: { leftArrow: true } }),
    { type: 'cursor.left' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: '\x1b[C', key: {} }),
    { type: 'cursor.right' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: '[H', key: {} }),
    { type: 'cursor.line.start' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: '\x1b[F', key: {} }),
    { type: 'cursor.line.end' },
  );
});

test('toCanonicalInputEvent maps shifted cursor keys to selection events', () => {
  assert.deepEqual(
    toCanonicalInputEvent({ input: '', key: { leftArrow: true, shift: true } }),
    { type: 'selection.left' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: '', key: { rightArrow: true, shift: true } }),
    { type: 'selection.right' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: '', key: { upArrow: true, shift: true } }),
    { type: 'selection.up' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: '', key: { downArrow: true, shift: true } }),
    { type: 'selection.down' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: '', key: { home: true, shift: true } }),
    { type: 'selection.line.start' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: '', key: { end: true, shift: true } }),
    { type: 'selection.line.end' },
  );
});

test('toCanonicalInputEvent maps raw shifted cursor sequences to selection events', () => {
  assert.deepEqual(
    toCanonicalInputEvent({ input: '\x1b[1;2D', key: {} }),
    { type: 'selection.left' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: '[1;2C', key: {} }),
    { type: 'selection.right' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: '\x1b[1;2A', key: {} }),
    { type: 'selection.up' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: '[1;2B', key: {} }),
    { type: 'selection.down' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: '\x1b[1;2H', key: {} }),
    { type: 'selection.line.start' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: '[8;2~', key: {} }),
    { type: 'selection.line.end' },
  );
});

test('toCanonicalInputEvent maps supported control keys', () => {
  assert.deepEqual(
    toCanonicalInputEvent({ input: 'c', key: { ctrl: true } }),
    { type: 'interrupt' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: 'a', key: { ctrl: true } }),
    { type: 'edit.select.all' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: 'k', key: { ctrl: true } }),
    { type: 'text.delete.to.line.end' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: 'w', key: { ctrl: true } }),
    { type: 'text.delete.word.backward' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: 'z', key: { ctrl: true } }),
    { type: 'edit.undo' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: 'z', key: { ctrl: true, shift: true } }),
    { type: 'edit.redo' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: 'Z', key: { ctrl: true } }),
    { type: 'edit.redo' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: 'y', key: { ctrl: true } }),
    { type: 'edit.redo' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: 'x', key: { ctrl: true } }),
    { type: 'noop' },
  );
});

test('toCanonicalInputEvent preserves unknown terminal controls as unknown controls', () => {
  assert.deepEqual(
    toCanonicalInputEvent({ input: '\x1b[1;3A', key: {} }),
    { type: 'unknown.control', raw: '\x1b[1;3A' },
  );
});
