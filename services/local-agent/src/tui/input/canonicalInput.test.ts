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
    toCanonicalInputEvent({ input: '', key: { backspace: true } }),
    { type: 'text.delete.backward' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: '', key: { delete: true } }),
    { type: 'text.delete.forward' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: '\x1b[3~', key: {} }),
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

test('toCanonicalInputEvent maps supported control keys', () => {
  assert.deepEqual(
    toCanonicalInputEvent({ input: 'c', key: { ctrl: true } }),
    { type: 'interrupt' },
  );
  assert.deepEqual(
    toCanonicalInputEvent({ input: 'a', key: { ctrl: true } }),
    { type: 'cursor.line.start' },
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
    toCanonicalInputEvent({ input: 'x', key: { ctrl: true } }),
    { type: 'noop' },
  );
});

test('toCanonicalInputEvent preserves unknown terminal controls as unknown controls', () => {
  assert.deepEqual(
    toCanonicalInputEvent({ input: '\x1b[1;2A', key: {} }),
    { type: 'unknown.control', raw: '\x1b[1;2A' },
  );
});
