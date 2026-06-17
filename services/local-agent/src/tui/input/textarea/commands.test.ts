import assert from 'node:assert/strict';
import test from 'node:test';
import { toTextAreaCommand } from './commands';

test('toTextAreaCommand maps canonical text events to textarea commands', () => {
  assert.deepEqual(toTextAreaCommand({ type: 'text.insert', text: 'x' }), {
    type: 'insert',
    text: 'x',
  });
  assert.deepEqual(toTextAreaCommand({ type: 'text.paste', text: 'a\nb' }), {
    type: 'paste',
    text: 'a\nb',
  });
  assert.deepEqual(toTextAreaCommand({ type: 'text.delete.backward' }), { type: 'deleteBackward' });
  assert.deepEqual(toTextAreaCommand({ type: 'text.delete.forward' }), { type: 'deleteForward' });
  assert.deepEqual(toTextAreaCommand({ type: 'text.delete.word.backward' }), { type: 'deleteWordBackward' });
  assert.deepEqual(toTextAreaCommand({ type: 'text.delete.to.line.start' }), { type: 'deleteToLineStart' });
  assert.deepEqual(toTextAreaCommand({ type: 'text.delete.to.line.end' }), { type: 'deleteToLineEnd' });
});

test('toTextAreaCommand maps canonical cursor events to textarea commands', () => {
  assert.deepEqual(toTextAreaCommand({ type: 'cursor.left' }), { type: 'moveLeft' });
  assert.deepEqual(toTextAreaCommand({ type: 'cursor.right' }), { type: 'moveRight' });
  assert.deepEqual(toTextAreaCommand({ type: 'cursor.up' }), { type: 'moveUp' });
  assert.deepEqual(toTextAreaCommand({ type: 'cursor.down' }), { type: 'moveDown' });
  assert.deepEqual(toTextAreaCommand({ type: 'cursor.line.start' }), { type: 'moveLineStart' });
  assert.deepEqual(toTextAreaCommand({ type: 'cursor.line.end' }), { type: 'moveLineEnd' });
  assert.deepEqual(toTextAreaCommand({ type: 'newline' }), { type: 'newline' });
});

test('toTextAreaCommand maps canonical selection events to textarea commands', () => {
  assert.deepEqual(toTextAreaCommand({ type: 'selection.left' }), { type: 'selectLeft' });
  assert.deepEqual(toTextAreaCommand({ type: 'selection.right' }), { type: 'selectRight' });
  assert.deepEqual(toTextAreaCommand({ type: 'selection.up' }), { type: 'selectUp' });
  assert.deepEqual(toTextAreaCommand({ type: 'selection.down' }), { type: 'selectDown' });
  assert.deepEqual(toTextAreaCommand({ type: 'selection.line.start' }), { type: 'selectLineStart' });
  assert.deepEqual(toTextAreaCommand({ type: 'selection.line.end' }), { type: 'selectLineEnd' });
});

test('toTextAreaCommand ignores app-level canonical events', () => {
  assert.equal(toTextAreaCommand({ type: 'submit' }), null);
  assert.equal(toTextAreaCommand({ type: 'escape' }), null);
  assert.equal(toTextAreaCommand({ type: 'interrupt' }), null);
  assert.equal(toTextAreaCommand({ type: 'tab', shift: false }), null);
  assert.equal(toTextAreaCommand({ type: 'unknown.control', raw: '\x1b[1;2A' }), null);
  assert.equal(toTextAreaCommand({ type: 'noop' }), null);
});
